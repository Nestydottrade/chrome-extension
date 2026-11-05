import { browser } from 'wxt/browser';

/**
 * False once Nesty was updated (or reloaded) under a page that still runs its old content
 * script: the runtime loses its id there, and every call to it throws.
 */
export function extensionAlive(): boolean {
  try {
    return Boolean(browser.runtime.id);
  } catch {
    return false;
  }
}
