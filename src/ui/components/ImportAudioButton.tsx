import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileAudio } from 'lucide-react';
import { localStore } from '../../app/localStore';
import { errorMessage } from '../../lib/errors';
import { IMPORT_ACCEPT, importAudioFile } from '../../services/importAudio';
import { useLibraryStore } from '../../state/libraryStore';
import { useSettingsStore } from '../../state/settingsStore';
import { toast } from '../../state/toastStore';
import { Button } from './primitives';

/** Lets the user bring an existing audio file (voice memo, downloaded call ...) into the library. */
export function ImportAudioButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' | 'ghost' }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const recording = await importAudioFile(file, {
        store: localStore,
        quality: useSettingsStore.getState().settings.quality,
      });
      useLibraryStore.getState().applyRecording(recording);
      toast.success('Audio imported. Open it to transcribe.');
      navigate(`/recording/${recording.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        className="sr-only"
        aria-label="Choose an audio file to import"
        tabIndex={-1}
        onChange={(event) => void onFile(event.target.files?.[0])}
      />
      <Button variant={variant} icon={<FileAudio />} loading={busy} onClick={() => inputRef.current?.click()}>
        Import audio
      </Button>
    </>
  );
}
