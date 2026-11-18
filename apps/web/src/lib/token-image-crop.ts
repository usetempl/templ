export type CropPosition = { zoom: number; x: number; y: number };
export type ImageSize = { width: number; height: number };

export const INITIAL_CROP: CropPosition = { zoom: 1, x: 0, y: 0 };
export const CROP_BACKGROUND = "#111111";
export const CROP_SIZE = 512;
export const MIN_CROP_ZOOM = 0.5;
export const MAX_CROP_ZOOM = 4;

export function validateCropImage(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.type,
    ) ||
    file.size === 0 ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG, WebP or GIF under 5 MB.");
}

// Positions are fractions of the square, so the same crop works at any size.
export function constrainCrop(
  size: ImageSize,
  crop: CropPosition,
): CropPosition {
  const zoom = Math.max(MIN_CROP_ZOOM, Math.min(MAX_CROP_ZOOM, crop.zoom));
  const scale = zoom / Math.max(size.width, size.height);
  const limitX = Math.abs(1 - size.width * scale) / 2;
  const limitY = Math.abs(1 - size.height * scale) / 2;
  return {
    zoom,
    x: Math.max(-limitX, Math.min(limitX, crop.x)),
    y: Math.max(-limitY, Math.min(limitY, crop.y)),
  };
}

export function cropPlacement(
  size: ImageSize,
  crop: CropPosition,
  side: number,
) {
  const bounded = constrainCrop(size, crop);
  const scale = (side * bounded.zoom) / Math.max(size.width, size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return {
    x: (side - width) / 2 + bounded.x * side,
    y: (side - height) / 2 + bounded.y * side,
    width,
    height,
  };
}

export function paintTokenCrop(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  crop: CropPosition,
) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare this image.");
  const placement = cropPlacement(bitmap, crop, canvas.width);
  context.fillStyle = CROP_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    bitmap,
    placement.x,
    placement.y,
    placement.width,
    placement.height,
  );
}

export async function exportTokenCrop(bitmap: ImageBitmap, crop: CropPosition) {
  const canvas = document.createElement("canvas");
  canvas.width = CROP_SIZE;
  canvas.height = CROP_SIZE;
  paintTokenCrop(canvas, bitmap, crop);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Could not prepare this image. Try another file.");
  // The caller applies the upload-size limit (prepareAvatarImage) after this export.
  return new File([blob], "token-image", { type: blob.type });
}
