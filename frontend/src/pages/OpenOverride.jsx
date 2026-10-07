import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useOverride } from '../components/OverrideContext';

/**
 * The old "Log entry" page was a form; the GateLog design makes it a dialog
 * that opens over whatever you were looking at. This keeps /log (bookmarks,
 * muscle memory) working: it opens the dialog and lands on the dashboard.
 */
export default function OpenOverride() {
  const { open } = useOverride();
  useEffect(() => {
    open();
  }, [open]);
  return <Navigate to="/" replace />;
}
