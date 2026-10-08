import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { cleanAnswers, FormFields, type IntakeForm } from '@/ui/forms';
import { Button, Card, Empty, ErrorState, Eyebrow, H1, Loading, Muted, Row, Screen, T, useAction } from '@/ui/kit';

/** Fill in an intake form as a workspace member. */
export default function FormFill() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const act = useAction();
  const { data: form, error, reload } = useApi<IntakeForm>(`/forms/${id}`);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [done, setDone] = useState<string | null>(null);
  if (error && !form) return <ErrorState error={error} retry={reload} />;
  if (!form) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Form' }} />
      {form.project && <Eyebrow>{form.project.name}</Eyebrow>}
      <H1>{form.title}</H1>
      {!!form.description && <Muted size={15}>{form.description}</Muted>}
      {done ? (
        <Card style={{ gap: 10 }}>
          <T weight="bold">Thanks — your request was sent.</T>
          <Row>
            <Button small title="View the task" onPress={() => router.push(`/tasks/${done}`)} />
            <Button
              small
              title="Send another"
              onPress={() => {
                setAnswers({});
                setDone(null);
              }}
            />
          </Row>
        </Card>
      ) : form.closed ? (
        <Empty icon="lock" title="This form is closed" />
      ) : (
        <Card style={{ gap: 14 }}>
          <FormFields questions={form.questions} answers={answers} onChange={setAnswers} />
          <Button
            title="Submit"
            variant="primary"
            full
            onPress={async () => {
              const missing = form.questions.find((q) => q.required && (answers[q.id] === undefined || answers[q.id] === ''));
              if (missing) return void act(async () => Promise.reject(new Error(`“${missing.label}” is required`)));
              const res = await act(() => api.post<{ taskId: string }>(`/forms/${form.id}/responses`, { answers: cleanAnswers(answers) }));
              if (res) setDone(res.taskId);
            }}
          />
        </Card>
      )}
    </Screen>
  );
}
