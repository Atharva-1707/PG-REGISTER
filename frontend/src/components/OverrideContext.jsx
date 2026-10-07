import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import OverrideModal from './OverrideModal';

/**
 * One manual-override dialog for the whole app. Any page can open it —
 * optionally with a guest already chosen — and `tick` bumps after each
 * saved entry so pages behind it can reload without being told which one.
 */
const OverrideContext = createContext({ open: () => {}, tick: 0 });

export const useOverride = () => useContext(OverrideContext);

export function OverrideProvider({ children }) {
  const [state, setState] = useState(null); // null = closed
  const [tick, setTick] = useState(0);

  const open = useCallback((opts = {}) => setState({ guestId: opts.guestId || null }), []);
  const close = useCallback(() => setState(null), []);
  const value = useMemo(() => ({ open, tick }), [open, tick]);

  return (
    <OverrideContext.Provider value={value}>
      {children}
      {state && (
        <OverrideModal
          // A fresh form each time it opens.
          key={`${state.guestId || 'none'}`}
          initialGuestId={state.guestId}
          onClose={close}
          onDone={() => setTick((t) => t + 1)}
        />
      )}
    </OverrideContext.Provider>
  );
}
