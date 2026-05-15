import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { VaultManager } from './vault-manager';
import { logger } from '@/utils/logger';
import { getAuthenticatedGitUrl } from './git-auth-provider';

export interface VaultConfig {
  repoUrl: string;
  branch: string;
  gitToken: string;
  gitUsername?: string;
  vaultPath: string;
}

// Skip re-syncing the vault if it was synced within this window. Reads no
// longer trigger a network round-trip per file, only the first read in a burst.
const SYNC_TTL_MS = Number(process.env.VAULT_SYNC_TTL_MS) || 15000;
// How many times to retry a failed sync before falling back to a reclone.
const SYNC_MAX_ATTEMPTS = Number(process.env.VAULT_SYNC_MAX_ATTEMPTS) || 3;
// Hard ceiling on any single git subprocess. If git produces no output for
// this long it is killed, so a hung clone/fetch can never pile up and exhaust
// the host process table (the cause of the 2026-05-14 `spawn git EAGAIN`).
const GIT_TIMEOUT_MS = Number(process.env.VAULT_GIT_TIMEOUT_MS) || 20000;

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export class GitVaultManager implements VaultManager {
  private config: VaultConfig;
  // Serializes every git/filesystem operation against the single working
  // copy. Without this, concurrent MCP requests race reset/clean/reclone
  // against each other and corrupt the vault mid-operation.
  private gitLock: Promise<unknown> = Promise.resolve();
  // Timestamp of the last successful sync, for TTL-based debouncing.
  private lastSyncAt = 0;

  constructor(config: VaultConfig) {
    this.config = config;
  }

  /**
   * Run a task with exclusive access to the vault working copy.
   * All public methods funnel through here, so only one git/fs operation
   * touches the working copy at a time regardless of request concurrency.
   */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.gitLock.then(task, task);
    // Keep the chain alive on failure without leaking unhandled rejections.
    this.gitLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private createGitInstance(baseDir?: string): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      timeout: { block: GIT_TIMEOUT_MS },
    };
    if (baseDir) {
      options.baseDir = baseDir;
    }
    return simpleGit(options).env({
      GIT_TERMINAL_PROMPT: '0',
    });
  }

  /**
   * Create authenticated URL by embedding credentials
   * Uses automatic provider detection to determine the correct authentication format
   */
  private getAuthenticatedUrl(): string {
    return getAuthenticatedGitUrl(
      this.config.repoUrl,
      this.config.gitToken,
      this.config.gitUsername,
    );
  }

  /**
   * Sanitize URL for logging (remove credentials)
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = parsed.username ? '***' : '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Ensure the working copy is present and reasonably fresh.
   * Caller MUST hold the runExclusive lock.
   * - Missing/corrupt working copy: clone.
   * - Synced within SYNC_TTL_MS (and not forced): skip — no network call.
   * - Otherwise: sync with remote.
   */
  private async initialize(force = false): Promise<void> {
    const vaultExists =
      existsSync(this.config.vaultPath) &&
      existsSync(path.join(this.config.vaultPath, '.git'));

    if (!vaultExists) {
      logger.info('Cloning vault', {
        repoUrl: this.sanitizeUrl(this.config.repoUrl),
        branch: this.config.branch,
      });
      await this.cloneVault();
      this.lastSyncAt = Date.now();
      return;
    }

    if (!force && Date.now() - this.lastSyncAt < SYNC_TTL_MS) {
      logger.debug('Vault sync skipped (within TTL)');
      return;
    }

    await this.syncVault();
    this.lastSyncAt = Date.now();
  }

  /**
   * Remove stale git lock files left behind by a crashed git process.
   * Because every git operation is serialized through runExclusive, any
   * lock file present at the start of an operation is necessarily stale —
   * no live git process owns it — so it is always safe to remove here.
   * This is what makes the "stuck in a git lock state" condition self-heal.
   */
  private async clearStaleGitLocks(): Promise<void> {
    const gitDir = path.join(this.config.vaultPath, '.git');
    if (!existsSync(gitDir)) return;

    const lockFiles = ['index.lock', 'shallow.lock', 'HEAD.lock', 'config.lock'];
    for (const name of lockFiles) {
      const lockPath = path.join(gitDir, name);
      if (existsSync(lockPath)) {
        logger.warn('Removing stale git lock file', { lockFile: name });
        await fs.rm(lockPath, { force: true });
      }
    }
  }

  /**
   * Remove the vault directory completely
   */
  private async removeVault(): Promise<void> {
    if (existsSync(this.config.vaultPath)) {
      logger.debug('Removing vault directory for fresh clone');
      await fs.rm(this.config.vaultPath, { recursive: true, force: true });
    }
  }

  /**
   * Clone the vault repository (cold start). Caller MUST hold the lock.
   */
  private async cloneVault(): Promise<void> {
    const tempGit = this.createGitInstance();
    const authUrl = this.getAuthenticatedUrl();

    await tempGit.clone(authUrl, this.config.vaultPath, {
      '--depth': 1,
      '--branch': this.config.branch,
      '--single-branch': null,
    });

    const vaultGit = this.createGitInstance(this.config.vaultPath);
    await vaultGit.addConfig('user.name', 'Obsidian MCP Server');
    await vaultGit.addConfig('user.email', 'mcp@obsidian.local');
  }

  /**
   * Sync vault with remote. Caller MUST hold the lock.
   * Retries on transient failure (clearing any stale lock first) and only
   * falls back to a destructive reclone once retries are exhausted — so a
   * single transient git/network hiccup no longer wipes the working copy.
   */
  private async syncVault(): Promise<void> {
    const startTime = Date.now();
    const authUrl = this.getAuthenticatedUrl();

    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt++) {
      try {
        await this.clearStaleGitLocks();

        const vaultGit = this.createGitInstance(this.config.vaultPath);
        await vaultGit.remote(['set-url', 'origin', authUrl]);

        logger.debug('Fetching latest changes from remote');
        await vaultGit.fetch('origin', this.config.branch);

        // Reset to clean "as cloned" state - matches remote exactly
        await vaultGit.reset(['--hard', `origin/${this.config.branch}`]);
        // Remove untracked files and directories (-f force, -d dirs, -x ignored)
        await vaultGit.clean('fdx');

        logger.info('Vault synced with remote', {
          durationMs: Date.now() - startTime,
          attempts: attempt,
          branch: this.config.branch,
        });
        return;
      } catch (error) {
        if (attempt < SYNC_MAX_ATTEMPTS) {
          logger.warn('Vault sync attempt failed, retrying', {
            attempt,
            maxAttempts: SYNC_MAX_ATTEMPTS,
            error: describeError(error),
          });
          await new Promise(resolve => setTimeout(resolve, attempt * 500));
          continue;
        }

        // Retries exhausted — working copy is likely corrupt; reclone.
        logger.error('Vault sync failed after retries, performing fresh clone', {
          durationMs: Date.now() - startTime,
          branch: this.config.branch,
          error: describeError(error),
        });
        await this.removeVault();
        await this.cloneVault();
      }
    }
  }

  /**
   * Commit and push changes. Caller MUST hold the lock.
   * Private method - called automatically after write operations
   */
  private async commitAndPush(message: string, affectedFiles: string[]): Promise<void> {
    await this.clearStaleGitLocks();
    const vaultGit = this.createGitInstance(this.config.vaultPath);

    if (affectedFiles.length > 0) {
      await vaultGit.raw(['add', '-A', ...affectedFiles]);
    } else {
      await vaultGit.raw(['add', '-A']);
    }

    const status = await vaultGit.status();
    if (status.files.length === 0) {
      logger.debug('No changes to commit');
      return;
    }

    await vaultGit.commit(message);
    await this.pushWithRetry(vaultGit, 3);
  }

  /**
   * Push with exponential backoff retry
   */
  private async pushWithRetry(vaultGit: SimpleGit, maxAttempts: number): Promise<void> {
    const startTime = Date.now();
    const authUrl = this.getAuthenticatedUrl();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Ensure remote URL has credentials before pushing
        await vaultGit.remote(['set-url', 'origin', authUrl]);
        await vaultGit.push('origin', this.config.branch);
        logger.info('Successfully pushed changes', {
          durationMs: Date.now() - startTime,
          attempts: attempt,
          branch: this.config.branch,
        });
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new Error(
            `Failed to push after ${maxAttempts} attempts: ${describeError(error).message}`,
          );
        }

        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('Push attempt failed, retrying', {
          attempt,
          maxAttempts,
          delayMs: delay,
          error: describeError(error),
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Read a file from the vault
   */
  async readFile(relativePath: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.initialize();
      const fullPath = path.join(this.config.vaultPath, relativePath);

      try {
        return await fs.readFile(fullPath, 'utf-8');
      } catch (error: any) {
        throw new Error(`Failed to read file ${relativePath}: ${error.message}`);
      }
    });
  }

  /**
   * Write content to a file
   * Automatically commits and pushes the change
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.initialize(true);
      const fullPath = path.join(this.config.vaultPath, relativePath);

      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(fullPath, content, 'utf-8');
      await this.commitAndPush(`Update file: ${relativePath}`, [relativePath]);

      logger.debug('File written successfully', {
        path: relativePath,
        sizeBytes: content.length,
      });
    });
  }

  /**
   * Delete a file
   * Automatically commits and pushes the change
   */
  async deleteFile(relativePath: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.initialize(true);
      const fullPath = path.join(this.config.vaultPath, relativePath);

      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          throw new Error(`Cannot delete ${relativePath}: it is a directory`);
        }

        await fs.unlink(fullPath);
        await this.commitAndPush(`Delete file: ${relativePath}`, [relativePath]);

        logger.debug('File deleted successfully', {
          path: relativePath,
        });
      } catch (error: any) {
        throw new Error(`Failed to delete file ${relativePath}: ${error.message}`);
      }
    });
  }

  /**
   * Move/rename a file
   * Automatically commits and pushes the change
   */
  async moveFile(sourcePath: string, destPath: string): Promise<void> {
    return this.runExclusive(async () => {
      await this.initialize(true);
      const fullSourcePath = path.join(this.config.vaultPath, sourcePath);
      const fullDestPath = path.join(this.config.vaultPath, destPath);

      const destDir = path.dirname(fullDestPath);
      await fs.mkdir(destDir, { recursive: true });

      await fs.rename(fullSourcePath, fullDestPath);
      await this.commitAndPush(`Move file: ${sourcePath} → ${destPath}`, [
        sourcePath,
        destPath,
      ]);
    });
  }

  /**
   * Create a directory
   */
  async createDirectory(relativePath: string, recursive: boolean): Promise<void> {
    return this.runExclusive(async () => {
      await this.initialize();
      const fullPath = path.join(this.config.vaultPath, relativePath);
      await fs.mkdir(fullPath, { recursive });
    });
  }

  /**
   * List files in a directory
   */
  async listFiles(
    relativePath: string = '',
    options: {
      includeDirectories?: boolean;
      fileTypes?: string[];
      recursive?: boolean;
    } = {},
  ): Promise<string[]> {
    return this.runExclusive(async () => {
      await this.initialize();
      const fullPath = path.join(this.config.vaultPath, relativePath);

      const files: string[] = [];
      await this.walkDirectory(fullPath, this.config.vaultPath, files, options);

      return files;
    });
  }

  /**
   * Recursively walk directory
   */
  private async walkDirectory(
    dir: string,
    basePath: string,
    files: string[],
    options: {
      includeDirectories?: boolean;
      fileTypes?: string[];
      recursive?: boolean;
    },
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.obsidian') {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        if (options.includeDirectories) {
          files.push(relativePath);
        }

        if (options.recursive !== false) {
          await this.walkDirectory(fullPath, basePath, files, options);
        }
      } else {
        if (options.fileTypes && options.fileTypes.length > 0) {
          const ext = path.extname(entry.name).substring(1);
          if (!options.fileTypes.includes(ext)) {
            continue;
          }
        }

        files.push(relativePath);
      }
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(relativePath: string): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.initialize();
      const fullPath = path.join(this.config.vaultPath, relativePath);
      return existsSync(fullPath);
    });
  }

  /**
   * Get the absolute path to the vault
   */
  getVaultPath(): string {
    return this.config.vaultPath;
  }
}
