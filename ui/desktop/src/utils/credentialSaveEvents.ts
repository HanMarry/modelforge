/**
 * Renderer-side notice that a key was saved into the desktop credential store, so the
 * settings page can show the outcome ("encrypted" or "not persisted") right away
 * (requirement 2.2, 2.3) without the save call site knowing where it is displayed.
 */
import type { CredentialSaveResult } from './credentialIpc';

export const CREDENTIAL_SAVED_EVENT = 'credential-saved';

export function announceCredentialSave(result: CredentialSaveResult): void {
  window.dispatchEvent(
    new CustomEvent<CredentialSaveResult>(CREDENTIAL_SAVED_EVENT, { detail: result })
  );
}

/** Calls `listener` after every save; returns the function that stops listening. */
export function onCredentialSaved(listener: (result: CredentialSaveResult) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<CredentialSaveResult>).detail);
  window.addEventListener(CREDENTIAL_SAVED_EVENT, handle);
  return () => window.removeEventListener(CREDENTIAL_SAVED_EVENT, handle);
}
