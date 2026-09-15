import type { PastedImage, DroppedFile } from './types';
import type { ImageData } from '../../types/message';

export const convertImagesToImageData = (
  pastedImages: PastedImage[],
  droppedFiles: DroppedFile[]
): ImageData[] => {
  const pastedImageData: ImageData[] = pastedImages
    .filter((img) => img.dataUrl && !img.error && !img.isLoading)
    .map((img) => {
      const matches = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        return {
          data: matches[2],
          mimeType: matches[1],
        };
      }
      return null;
    })
    .filter((img): img is ImageData => img !== null);

  const droppedImageData: ImageData[] = droppedFiles
    .filter((file) => file.isImage && file.dataUrl && !file.error && !file.isLoading)
    .map((file) => {
      const matches = file.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        return {
          data: matches[2],
          mimeType: matches[1],
        };
      }
      return null;
    })
    .filter((img): img is ImageData => img !== null);

  return [...pastedImageData, ...droppedImageData];
};

export const appendDroppedFilePaths = (
  droppedFiles: DroppedFile[],
  text: string
): string => {
  const droppedFilePaths = droppedFiles
    .filter((file) => !file.isImage && !file.error && !file.isLoading)
    .map((file) => file.path);

  if (droppedFilePaths.length > 0) {
    const pathsString = droppedFilePaths.join(' ');
    return text ? `${text} ${pathsString}` : pathsString;
  }
  return text;
};

export const hasSubmittableContent = (
  pastedImages: PastedImage[],
  droppedFiles: DroppedFile[]
): boolean => {
  return (
    pastedImages.some((img) => img.dataUrl && !img.error && !img.isLoading) ||
    droppedFiles.some((file) => !file.error && !file.isLoading)
  );
};

export const isAnyLoading = (
  pastedImages: PastedImage[],
  droppedFiles: DroppedFile[]
): boolean => {
  return (
    pastedImages.some((img) => img.isLoading) || droppedFiles.some((file) => file.isLoading)
  );
};
