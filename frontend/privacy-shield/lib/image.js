// Image decoding for the OCR step. Browser port of the sharp-based
// `ImageOps.exif_transpose(source).convert("RGB")` step: EXIF orientation is baked into
// the pixels, transparency is dropped onto a white background, and the caller gets a
// plain PNG blob plus the page dimensions the UI needs — same contract as the backend
// version, just built from a <canvas> instead of libvips.

// `createImageBitmap(..., { imageOrientation: "from-image" })` is what applies EXIF
// rotation for us; every current browser supports it. Colour space is left to the
// browser's own sRGB canvas — there is no client-side equivalent of forcing an ICC
// profile the way sharp's `.toColourspace("srgb")` does, but virtually all photos and
// scans are already sRGB, so this only differs from the backend on wide-gamut source
// images.
export async function normalizeImage(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: false });
  // Flatten onto white first: sharp's `.removeAlpha()` drops the alpha channel outright,
  // which is only visually equivalent to matting over white when the pixels underneath
  // a transparent area are otherwise blank, as they are for the scans/screenshots this
  // tool targets.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const png = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("The browser could not encode the image."))),
      "image/png",
    );
  });
  return { png, width: canvas.width, height: canvas.height, canvas };
}
