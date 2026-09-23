/**
 * Hand a generated file to the user. On phones the share sheet (Save to Files,
 * Mail, …) is used, because a plain download inside an installed iOS PWA opens
 * a dead-end viewer with no way back.
 */
export async function deliver(blob: Blob, fileName: string, type: string, title: string): Promise<void> {
  const file = new File([blob], fileName, { type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // NotAllowedError etc.: fall through to a normal download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
