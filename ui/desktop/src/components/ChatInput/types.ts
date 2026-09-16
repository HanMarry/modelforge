export interface PastedImage {
  id: string;
  dataUrl: string;
  isLoading: boolean;
  error?: string;
}

export interface DroppedFile {
  id: string;
  name: string;
  path: string;
  type: string;
  isImage: boolean;
  dataUrl?: string;
  isLoading?: boolean;
  error?: string;
}
