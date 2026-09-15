import { Button } from '../ui/button';
import { Close } from '../icons';
import { defineMessages, useIntl } from '../../i18n';
import { PastedImage, DroppedFile } from './types';

const i18n = defineMessages({
  removeImage: {
    id: 'fileAttachment.removeImage',
    defaultMessage: 'Remove image',
  },
  removeFile: {
    id: 'fileAttachment.removeFile',
    defaultMessage: 'Remove file',
  },
  unknownType: {
    id: 'fileAttachment.unknownType',
    defaultMessage: 'Unknown type',
  },
});

interface FileAttachmentProps {
  pastedImages: PastedImage[];
  droppedFiles: DroppedFile[];
  onPastedImagesChange: (images: PastedImage[]) => void;
  onRemovePastedImage: (id: string) => void;
  onRemoveDroppedFile: (id: string) => void;
  disabled?: boolean;
}

export const FileAttachment = ({
  pastedImages,
  droppedFiles,
  onRemovePastedImage,
  onRemoveDroppedFile,
  disabled = false,
}: FileAttachmentProps) => {
  const intl = useIntl();

  if (pastedImages.length === 0 && droppedFiles.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 p-4 mt-2 border-t border-border-primary">
      {/* Render pasted images first */}
      {pastedImages.map((img) => (
        <div key={img.id} className="relative group w-20 h-20">
          {img.dataUrl && (
            <img
              src={img.dataUrl}
              alt={`Pasted image ${img.id}`}
              className={`w-full h-full object-cover rounded border ${img.error ? 'border-red-500' : 'border-border-primary'}`}
            />
          )}
          {img.isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded">
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
            </div>
          )}
          {img.error && !img.isLoading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-75 rounded p-1 text-center">
              <p className="text-red-400 text-[10px] leading-tight break-all">
                {img.error.substring(0, 50)}
              </p>
            </div>
          )}
          {!img.isLoading && !disabled && (
            <Button
              type="button"
              shape="round"
              onClick={() => onRemovePastedImage(img.id)}
              className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
              aria-label={intl.formatMessage(i18n.removeImage)}
              variant="outline"
              size="xs"
            >
              <Close className="w-4 h-4" />
            </Button>
          )}
        </div>
      ))}

      {/* Render dropped files after pasted images */}
      {droppedFiles.map((file) => (
        <div key={file.id} className="relative group">
          {file.isImage ? (
            <div className="w-20 h-20">
              {file.dataUrl && (
                <img
                  src={file.dataUrl}
                  alt={file.name}
                  className={`w-full h-full object-cover rounded border ${file.error ? 'border-red-500' : 'border-border-primary'}`}
                />
              )}
              {file.isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded">
                  <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
                </div>
              )}
              {file.error && !file.isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-75 rounded p-1 text-center">
                  <p className="text-red-400 text-[10px] leading-tight break-all">
                    {file.error.substring(0, 30)}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-bgSubtle border border-border-primary rounded-lg min-w-[120px] max-w-[200px]">
              <div className="flex-shrink-0 w-8 h-8 bg-background-primary border border-border-primary rounded flex items-center justify-center text-xs font-mono text-text-secondary">
                {file.name.split('.').pop()?.toUpperCase() || 'FILE'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text-primary truncate" title={file.name}>
                  {file.name}
                </p>
                <p className="text-xs text-text-secondary">
                  {file.type || intl.formatMessage(i18n.unknownType)}
                </p>
              </div>
            </div>
          )}
          {!file.isLoading && !disabled && (
            <Button
              type="button"
              shape="round"
              onClick={() => onRemoveDroppedFile(file.id)}
              className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
              aria-label={intl.formatMessage(i18n.removeFile)}
              variant="outline"
              size="xs"
            >
              <Close className="w-4 h-4" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
};

export type { FileAttachmentProps };
