import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Toaster, toast } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

// ---------- Toasts ----------

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

/** Show a toast from anywhere, including outside React. Errors stay up longer. */
export function notify(text: string, tone: ToastTone = 'info', options: { description?: string; action?: { label: string; onClick: () => void } } = {}) {
  return toast.add({
    title: text,
    description: options.description,
    type: tone === 'info' ? undefined : tone,
    timeout: tone === 'error' ? 5000 : 2600,
    actionProps: options.action ? { children: options.action.label, onClick: options.action.onClick } : undefined,
  });
}

/** The toast function, as a hook (kept for the many screens that already call `useToast()`). */
export const useToast = () => notify;

/** Wrap an async action: show API errors as toasts, and an optional success message. */
export function useAction() {
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const result = await fn();
      if (success) notify(success, 'success');
      return result;
    } catch (e) {
      // A plan limit isn't a failure to retry: say what the limit is and offer the plans, without blocking anything else.
      if ((e as { details?: { code?: string } }).details?.code === 'plan_limit') {
        notify((e as Error).message, 'warning', {
          action: { label: 'See plans', onClick: () => window.dispatchEvent(new CustomEvent('kuu:see-plans')) },
        });
        return undefined;
      }
      notify((e as Error).message || 'Something went wrong', 'error');
      return undefined;
    }
  }, []);
}

// ---------- Confirmations ----------

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the red button. */
  destructive?: boolean;
}

type Confirm = (options: ConfirmOptions | string) => Promise<boolean>;
const ConfirmContext = createContext<Confirm>(async () => false);

/**
 * `const confirm = useConfirm(); if (!(await confirm({ title: 'Delete this?', destructive: true }))) return;`
 * A drop-in for `window.confirm` that matches the app and works on phones.
 */
export const useConfirm = () => useContext(ConfirmContext);

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(ok: boolean) => void>(undefined);
  const confirm = useCallback<Confirm>((options) => {
    resolver.current?.(false);
    setRequest(typeof options === 'string' ? { title: options } : options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = undefined;
    setRequest(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!request} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{request?.title}</AlertDialogTitle>
            {request?.description && <AlertDialogDescription>{request.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{request?.cancelLabel ?? 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction variant={request?.destructive ? 'destructive' : 'default'} onClick={() => settle(true)}>
              {request?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/** Everything app-wide that overlays depend on: tooltips, toasts and confirmations. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={300}>
      <Toaster limit={4}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </Toaster>
    </TooltipProvider>
  );
}
