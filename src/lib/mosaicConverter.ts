/**
 * mosaicConverter.ts
 * Re-exports UniversalMosaicEngine.ts for backwards compatibility.
 */

import {
  FactoryStud,
  FACTORY_ROUND_STOCK,
  rgbToLab,
  deltaE,
  convertAnyImageToMosaic,
  mapDownsampledBufferToMosaic,
} from "./UniversalMosaicEngine";
import { normalizeAndDownsampleBuffer } from "./PixelArtConverter";

export type PaletteColor = FactoryStud;
export const FACTORY_PALETTE: PaletteColor[] = FACTORY_ROUND_STOCK;
export {
  FACTORY_ROUND_STOCK,
  rgbToLab,
  deltaE,
  convertAnyImageToMosaic,
  mapDownsampledBufferToMosaic,
};

export function convertImageToMosaic(sourceCanvas: HTMLCanvasElement): string[][] {
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
  const imgData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const downsampled32 = normalizeAndDownsampleBuffer(
    new Uint8ClampedArray(imgData.data),
    sourceCanvas.width,
    sourceCanvas.height,
    32,
    4
  );
  const { matrix } = mapDownsampledBufferToMosaic(downsampled32, 32, 4);
  return matrix;
}
