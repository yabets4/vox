/*
 * vox/src/lib/save.js — hand a finished WAV to the user.
 *
 * Browser: classic <a download>.
 * Android (Capacitor): WebView ignores blob downloads, so the file is written to the
 * app cache and passed to the system share sheet (Files, Drive, a music player…).
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export async function saveAudio(blob, filename) {
  if (!Capacitor.isNativePlatform()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return 'downloaded';
  }
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
  });
  await Share.share({ title: filename, files: [uri], dialogTitle: 'Save audiobook' });
  return 'shared';
}
