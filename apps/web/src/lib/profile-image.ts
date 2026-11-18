export const AVATAR_SIZE = 256;
const AVATAR_LIMIT = 48 * 1024;

/** Keep profile uploads within the media limit. Workspace logos retain their shape. */
export async function prepareAvatarImage(
  file: File | Blob,
  fit: "stretch" | "contain" = "stretch",
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context || !bitmap.width || !bitmap.height)
      throw new Error("Could not resize this image.");
    for (const side of [AVATAR_SIZE, 192, 128]) {
      canvas.width = side;
      canvas.height = side;
      context.clearRect(0, 0, side, side);
      const scale = side / Math.max(bitmap.width, bitmap.height);
      const width = fit === "contain" ? bitmap.width * scale : side;
      const height = fit === "contain" ? bitmap.height * scale : side;
      context.drawImage(
        bitmap,
        (side - width) / 2,
        (side - height) / 2,
        width,
        height,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (
        blob?.type === "image/png" &&
        blob.size > 0 &&
        blob.size <= AVATAR_LIMIT
      )
        return blob;
    }
    throw new Error("Choose a simpler picture.");
  } finally {
    bitmap.close();
  }
}
