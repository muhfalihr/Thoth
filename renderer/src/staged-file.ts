/**
 * Writing a file that is published by a rename.
 *
 * Both writers here follow the same shape: create a staging entry beside the
 * destination, put the bytes in it, make them durable, and rename it over the
 * destination in one step. The security in that shape is the create: it is
 * exclusive, so a node someone else left at the staging path is never opened
 * and never followed, and the cleanup afterwards removes that one entry
 * without looking at whatever it might have pointed at.
 */

import { open, unlink } from "node:fs/promises";

/**
 * Put `contents` in a staging entry this call creates itself.
 *
 * `wx` is `O_CREAT | O_EXCL`: an existing file, directory, or link at the path
 * fails the open rather than being written through. The bytes go through the
 * handle that create returned, so they cannot be redirected after the check.
 */
export async function writeStagedFile(
  staging: string,
  contents: string,
  mode: number,
): Promise<void> {
  const handle = await open(staging, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Remove a staging entry, and only it.
 *
 * `unlink` removes the directory entry rather than what it may refer to, and a
 * failure here is not worth a second failure: the entry was never published,
 * and every caller is already on its way to refusing.
 */
export async function removeStagedFile(staging: string): Promise<void> {
  await unlink(staging).catch(() => {});
}
