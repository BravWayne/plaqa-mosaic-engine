/**
 * UniversalMosaicEngine.ts
 * Re-exports MasterMosaicEngine.ts (38% Damped Error Diffusion & ROUND_STUD_STOCK).
 */

import {
  FactoryStud,
  ROUND_STUD_STOCK,
  getLabDist,
  rgbToLab,
  convertToMasterMosaic,
  convertDownsampledBufferToMasterMosaic,
  ConversionOptions,
  GraphicDetectionResult,
  isGraphicOrPoster,
  detectGraphicOrPoster,
  renderPosterMosaicBuffer,
  renderPhotoMosaicBuffer,
  convertDownsampledBufferSmart,
  renderPhotoMosaic,
  renderPosterMosaic,
  convertImage,
  MidtoneAnalysisResult,
  analyzeMidtones,
  getTightContentBounds,
  renderCleanTwoColorMosaic,
  renderCleanTwoColorMosaicBuffer,
  renderApprovedPhotoMosaic,
  convertImageAutomatically,
} from "./MasterMosaicEngine";

export {
  FactoryStud,
  FactoryStud as WarehouseSKU,
  FactoryStud as FactoryColor,
  ROUND_STUD_STOCK,
  ROUND_STUD_STOCK as FACTORY_ROUND_STOCK,
  ROUND_STUD_STOCK as IN_STOCK_ROUND_PALETTE,
  ROUND_STUD_STOCK as IN_STOCK_PALETTE,
  getLabDist,
  rgbToLab,
  convertToMasterMosaic,
  convertToMasterMosaic as convertAnyImageToMosaic,
  convertDownsampledBufferToMasterMosaic,
  convertDownsampledBufferToMasterMosaic as mapDownsampledBufferToMosaic,
  ConversionOptions,
  GraphicDetectionResult,
  isGraphicOrPoster,
  detectGraphicOrPoster,
  renderPosterMosaicBuffer,
  renderPhotoMosaicBuffer,
  convertDownsampledBufferSmart,
  renderPhotoMosaic,
  renderPosterMosaic,
  convertImage,
  MidtoneAnalysisResult,
  analyzeMidtones,
  getTightContentBounds,
  renderCleanTwoColorMosaic,
  renderCleanTwoColorMosaicBuffer,
  renderApprovedPhotoMosaic,
  convertImageAutomatically,
};

export function deltaE(lab1: [number, number, number], lab2: [number, number, number]): number {
  return getLabDist(lab1[0], lab1[1], lab1[2], lab2);
}
