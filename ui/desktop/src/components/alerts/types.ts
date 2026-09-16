export enum AlertType {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export interface Alert {
  type: AlertType;
  message: string;
  autoShow?: boolean;
  action?: {
    text: string;
    onClick: () => void;
  };
  progress?: {
    current: number;
    total: number;
  };
  showCompactButton?: boolean;
  /** goose's own auto-compact threshold is meaningless when a kernel manages the context. */
  showAutoCompactThreshold?: boolean;
  compactButtonDisabled?: boolean;
  onCompact?: () => void;
  compactIcon?: React.ReactNode;
  onThresholdChange?: (threshold: number) => void;
}
