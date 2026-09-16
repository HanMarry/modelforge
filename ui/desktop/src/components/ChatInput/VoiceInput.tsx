import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { Microphone } from '../icons';
import { cn } from '../../utils';
import { trackVoiceDictation } from '../../utils/analytics';

interface VoiceInputProps {
  isEnabled: boolean;
  dictationProvider: string | null;
  isRecording: boolean;
  isTranscribing: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export const VoiceInput = ({
  isEnabled,
  dictationProvider,
  isRecording,
  isTranscribing,
  onStartRecording,
  onStopRecording,
}: VoiceInputProps) => {
  if (!dictationProvider) {
    return null;
  }

  const handleMicClick = () => {
    if (!isEnabled) return;
    if (isRecording) {
      trackVoiceDictation('stop');
      onStopRecording();
    } else {
      trackVoiceDictation('start');
      onStartRecording();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          shape="round"
          onClick={handleMicClick}
          disabled={isTranscribing}
          aria-disabled={!isEnabled}
          className={cn(
            'transition-colors',
            isRecording
              ? 'text-red-500 hover:text-red-600'
              : 'text-text-primary/70 hover:text-text-primary',
            isTranscribing && 'animate-pulse',
            !isEnabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          <Microphone size={16} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {!isEnabled ? (
          <p>Dictation not configured (Settings)</p>
        ) : (
          <p>Voice dictation{isRecording ? '' : ' • Say "submit" to send'}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
};

export type { VoiceInputProps };
