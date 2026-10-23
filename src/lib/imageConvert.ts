/** Convert a phone photo to an optimized JPEG in the browser.
 * - Honors EXIF orientation (createImageBitmap "from-image").
 * - Downscales to a 2048px longest side, JPEG quality 0.85.
 * - The canvas re-encode strips EXIF, including GPS location.
 * - HEIC/HEIF: Safari can usually decode it (the canvas path then works);
 *   browsers that cannot decode HEIC get a plain-English explanation. */
export async function convertToJpeg(file: File): Promise<Blob> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = null;
  }
  if (!bitmap) {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }
  }
  if (!bitmap) {
    const name = file.name.toLowerCase();
    if (file.type === "image/heic" || file.type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif")) {
      throw new Error(
        "This photo is in HEIC format and couldn't be converted on this phone. " +
          "On iPhone: Settings → Camera → Formats → “Most Compatible”, then take the photo again — " +
          "or pick it from the gallery instead.",
      );
    }
    if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
    throw new Error("This file isn't a photo we can use. Please take a photo or pick a JPG/PNG from the gallery.");
  }
  const maxSide = 2048;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process this photo on this phone. Please try again.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't process this photo on this phone. Please try again.");
  return blob; // canvas re-encode also strips EXIF / location metadata
}
