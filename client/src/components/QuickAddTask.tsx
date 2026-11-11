import { useMemo, useState, type FormEvent } from 'react';
import { api, type Project } from '../api';
import { useApi } from '../hooks';
import { localToday } from '../format';
import { parseQuickAdd, type QuickAddToken } from '../quickAdd';
import { usePeople } from '../session';
import { Icon } from './Icon';
import { useAction } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

const CHIP_ICON: Record<QuickAddToken['kind'], string> = { due: 'calendar', priority: 'flag', owner: 'users', project: 'folder', repeat: 'repeat' };
const CHIP_NAME: Record<QuickAddToken['kind'], string> = { due: 'due date', priority: 'priority', owner: 'owner', project: 'project', repeat: 'repeat' };

/**
 * One line to a task: "Send deck to @maya friday !high #brand refresh". What it understood shows as chips while
 * you type; × on a chip leaves those words in the title instead.
 */
export function QuickAddTask({
  onCreated,
  defaultDue,
  placeholder = 'Add a task — try “Call @maya tomorrow !high”',
  className,
  extra,
}: {
  onCreated: () => void;
  /** Used when the text names no date (e.g. today, on Home's focus list). */
  defaultDue?: string | null;
  placeholder?: string;
  className?: string;
  /** A field the parse leaves out, such as a date chosen with a picker beside it. */
  extra?: React.ReactNode;
}) {
  const people = usePeople();
  const act = useAction();
  const { data: projects } = useApi<Project[]>('/projects');
  const [text, setText] = useState('');
  const [skip, setSkip] = useState<Set<QuickAddToken['kind']>>(new Set());
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(
    () => parseQuickAdd(text, { people: people.map((p) => ({ id: p.id, name: p.name })), projects: (projects ?? []).map((p) => ({ id: p.id, name: p.name })), skip }),
    [text, people, projects, skip],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.title || busy) return;
    setBusy(true);
    const ok = await act(
      () =>
        api.post('/tasks', {
          title: parsed.title,
          // A repeating task starts today unless a day was given.
          dueDate: parsed.dueDate ?? defaultDue ?? (parsed.recurrence ? localToday() : null),
          ...(parsed.recurrence ? { recurrence: parsed.recurrence } : {}),
          ...(parsed.priority ? { priority: parsed.priority } : {}),
          ...(parsed.ownerId ? { ownerId: parsed.ownerId } : {}),
          ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
        }),
      'Task added',
    );
    setBusy(false);
    if (!ok) return;
    setText('');
    setSkip(new Set());
    onCreated();
  };

  return (
    <form onSubmit={submit} className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-sm:basis-full min-w-48 flex-1">
          <InputGroupAddon>
            <Icon name="plus" />
          </InputGroupAddon>
          <InputGroupInput
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) setSkip(new Set());
            }}
            placeholder={placeholder}
            aria-label="New task"
            aria-describedby="quick-add-understood"
            enterKeyHint="done"
          />
        </InputGroup>
        {extra}
        <Button disabled={!parsed.title || busy} type="submit">
          Add
        </Button>
      </div>
      <div id="quick-add-understood" aria-live="polite" className="flex min-h-6 flex-wrap items-center gap-1.5">
        {parsed.tokens.map((t) => (
          <span key={t.kind} className="inline-flex items-center gap-1 rounded-full border bg-accent/60 py-0.5 pr-0.5 pl-2 text-xs text-accent-foreground">
            <Icon name={CHIP_ICON[t.kind]} size={12} /> {t.label}
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-background/70"
              aria-label={`Keep “${t.text}” in the title instead of using it as the ${CHIP_NAME[t.kind]}`}
              onClick={() => setSkip(new Set(skip).add(t.kind))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {!parsed.tokens.length && <span className="text-xs text-muted-foreground">Dates like “friday” or “in 3 days”, “every day” to repeat, !high for priority, @name to assign, #project to file it.</span>}
      </div>
    </form>
  );
}
