import { defaultUntil, REPEAT_OPTIONS, type Recurrence } from '../repeat';
import { DatePicker, FormField } from '@/components/kit';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

/**
 * Whether a task repeats, and until when. With "Never ends" it keeps coming back each time it's completed until
 * someone stops it.
 */
export function RepeatFields({
  recurrence,
  until,
  onChange,
  minUntil,
  disabled,
}: {
  recurrence: Recurrence | '';
  until: string;
  onChange: (next: { recurrence: Recurrence | ''; until: string }) => void;
  /** The end date can't be before this (the task's due date). */
  minUntil?: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
      <FormField label="Repeats" hint={recurrence ? 'When it’s done, the next one appears with the same details.' : undefined}>
        <NativeSelect value={recurrence} disabled={disabled} onChange={(e) => onChange({ recurrence: e.target.value as Recurrence | '', until: e.target.value ? until : '' })}>
          <NativeSelectOption value="">Doesn’t repeat</NativeSelectOption>
          {REPEAT_OPTIONS.map((o) => (
            <NativeSelectOption key={o.value} value={o.value}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      {recurrence && (
        <FormField label="Ends">
          <div className="flex flex-col gap-2">
            <NativeSelect value={until ? 'on' : 'never'} disabled={disabled} aria-label="When it stops repeating" onChange={(e) => onChange({ recurrence, until: e.target.value === 'on' ? defaultUntil(minUntil) : '' })}>
              <NativeSelectOption value="never">Never — repeats until stopped</NativeSelectOption>
              <NativeSelectOption value="on">On a date</NativeSelectOption>
            </NativeSelect>
            {until && <DatePicker value={until} min={minUntil} clearable={false} disabled={disabled} aria-label="Last day it repeats" onChange={(v) => v && onChange({ recurrence, until: v })} placeholder="Last day" />}
          </div>
        </FormField>
      )}
    </div>
  );
}
