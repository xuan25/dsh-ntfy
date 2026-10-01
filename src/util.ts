// dsh-ntfy shared utilities: plugin identifier, package-root resolution, and
// low-level helpers (error message extraction, plain-object check).
//
// Pure Node dependencies, no framework packages; safe to import from selftest.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identifier (registered name, logger tag, skill provider name, prompt section name). */
export const PLUGIN_NAME = 'dsh-ntfy'

/** Error message extraction (catch variables are unknown under strict). */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Plain-object check: an object that is neither null nor an array. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolve the package root: both src/ (development) and lib/ (compiled) sit one level
 * below the package root, so '..' from this file's directory is the package root in
 * both states.
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
