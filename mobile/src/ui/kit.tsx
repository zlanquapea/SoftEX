import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { initials } from '../lib/format';
import { realtime } from '../lib/realtime';
import { fonts, radius, swatch, useStyles, useTheme, type Palette } from '../lib/theme';
import { Icon } from './Icon';

// ---------- Text ----------

type Tone = 'ink' | 'ink2' | 'muted' | 'accent' | 'red' | 'green' | 'amber' | 'blue' | 'onAccent';

export function T({
  children,
  size = 15,
  weight = 'body',
  tone = 'ink',
  style,
  ...rest
}: TextProps & { size?: number; weight?: keyof typeof fonts; tone?: Tone; style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  const color = { ink: c.ink, ink2: c.ink2, muted: c.muted, accent: c.accentInk, red: c.red, green: c.green, amber: c.amberInk, blue: c.blueInk, onAccent: c.onAccent }[tone];
  return (
    <Text {...rest} style={[{ fontFamily: fonts[weight], fontSize: size, color, lineHeight: Math.round(size * 1.4) }, style]}>
      {children}
    </Text>
  );
}

export const H1 = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) => (
  <T size={26} weight="displayHeavy" style={[{ letterSpacing: -0.4, lineHeight: 32 }, style]} accessibilityRole="header">
    {children}
  </T>
);
export const H2 = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) => (
  <T size={17} weight="display" style={[{ letterSpacing: -0.2 }, style]} accessibilityRole="header">
    {children}
  </T>
);
export const Muted = ({ children, size = 13, style, numberOfLines }: { children: ReactNode; size?: number; style?: StyleProp<TextStyle>; numberOfLines?: number }) => (
  <T size={size} tone="muted" style={style} numberOfLines={numberOfLines}>
    {children}
  </T>
);
export const Eyebrow = ({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) => (
  <T size={11} weight="bold" tone="muted" style={[{ letterSpacing: 0.8, textTransform: 'uppercase' }, style]}>
    {children}
  </T>
);

// ---------- Layout ----------

/** A scrolling screen on the warm canvas, with pull-to-refresh. */
export function Screen({
  children,
  refreshing,
  onRefresh,
  padded = true,
  scroll = true,
  style,
  contentStyle,
  ...rest
}: ScrollViewProps & { refreshing?: boolean; onRefresh?: () => void; padded?: boolean; scroll?: boolean; contentStyle?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  if (!scroll) return <View style={[{ flex: 1, backgroundColor: c.canvas }, style]}>{children}</View>;
  return (
    <ScrollView
      {...rest}
      style={[{ flex: 1, backgroundColor: c.canvas }, style]}
      contentContainerStyle={[padded && { padding: 16, paddingBottom: 32 + insets.bottom, gap: 14 }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.accent} colors={[c.accent]} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Row({ children, gap = 8, style, wrap }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function Card({ children, style, onPress, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; padded?: boolean }) {
  const s = useStyles(cardStyles);
  const body = [s.card, padded && { padding: 16 }, style];
  if (!onPress) return <View style={body}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [...body, pressed && s.pressed]} accessibilityRole="button">
      {children}
    </Pressable>
  );
}
const cardStyles = (c: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      shadowColor: c.shadow,
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 1,
    },
    pressed: { opacity: 0.85, transform: [{ scale: 0.995 }] },
  });

/** A card section with a heading and an optional action on the right. */
export function Section({ title, action, children, count, style }: { title: string; action?: ReactNode; children: ReactNode; count?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Card style={style}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <Row gap={6} style={{ flexShrink: 1 }}>
          <H2>{title}</H2>
          {!!count && <Badge count={count} tone="muted" />}
        </Row>
        {action}
      </Row>
      {children}
    </Card>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: c.line }, style]} />;
}

/** A tappable list row: avatar/icon on the left, title + subtitle, and something on the right. */
export function ListRow({
  title,
  subtitle,
  left,
  right,
  onPress,
  onLongPress,
  chevron,
  style,
  titleLines = 1,
  bold,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  style?: StyleProp<ViewStyle>;
  titleLines?: number;
  bold?: boolean;
}) {
  const { c } = useTheme();
  const content = (
    <>
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? (
          <T weight={bold ? 'bold' : 'semibold'} numberOfLines={titleLines}>
            {title}
          </T>
        ) : (
          title
        )}
        {typeof subtitle === 'string' ? (
          <Muted numberOfLines={2} style={{ marginTop: 1 }}>
            {subtitle}
          </Muted>
        ) : (
          subtitle
        )}
      </View>
      {right}
      {chevron && <Icon name="chevronRight" size={18} color={c.muted} />}
    </>
  );
  const base: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 };
  if (!onPress && !onLongPress) return <View style={[base, style]}>{content}</View>;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [base, style, pressed && { backgroundColor: c.hover }]} accessibilityRole="button">
      {content}
    </Pressable>
  );
}

// ---------- Buttons ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';

export function Button({
  title,
  onPress,
  variant = 'secondary',
  icon,
  small,
  disabled,
  loading,
  style,
  full,
  accessibilityLabel,
}: {
  title?: string;
  onPress?: () => void | Promise<unknown>;
  variant?: Variant;
  icon?: string;
  small?: boolean;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  full?: boolean;
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  const [busy, setBusy] = useState(false);
  const bg = { primary: c.accent, secondary: c.surface, ghost: 'transparent', danger: c.redSoft, soft: c.accentSoft }[variant];
  const fg = { primary: c.onAccent, secondary: c.ink, ghost: c.ink2, danger: c.red, soft: c.accentInk }[variant];
  const border = { primary: c.accent, secondary: c.lineStrong, ghost: 'transparent', danger: c.redLine, soft: c.accentLine }[variant];
  const working = loading || busy;
  const press = async () => {
    if (!onPress || working) return;
    const r = onPress();
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      setBusy(true);
      try {
        await r;
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <Pressable
      onPress={press}
      disabled={disabled || working}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: disabled || working, busy: working }}
      hitSlop={small ? 6 : 0}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          minHeight: small ? 32 : 44,
          paddingHorizontal: title ? (small ? 12 : 16) : small ? 6 : 10,
          borderRadius: small ? radius.md : 11,
          backgroundColor: bg,
          borderWidth: 1,
          borderColor: border,
          opacity: disabled ? 0.5 : 1,
          alignSelf: full ? 'stretch' : 'flex-start',
        },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {working ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 15 : 17} color={fg} /> : null}
      {!!title && (
        <T size={small ? 13 : 15} weight="bold" style={{ color: fg }} numberOfLines={1}>
          {title}
        </T>
      )}
    </Pressable>
  );
}

export function IconButton({ name, onPress, label, color, size = 20, badge, style }: { name: string; onPress?: () => void; label: string; color?: string; size?: number; badge?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={({ pressed }) => [{ padding: 8, borderRadius: 10 }, pressed && { backgroundColor: c.hover }, style]}>
      <Icon name={name} size={size} color={color ?? c.ink2} />
      {!!badge && (
        <View style={{ position: 'absolute', top: 2, right: 2 }}>
          <Badge count={badge} />
        </View>
      )}
    </Pressable>
  );
}

/** A small text link-style button. */
export function LinkText({ children, onPress, tone = 'accent', size = 14 }: { children: ReactNode; onPress: () => void; tone?: Tone; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="link">
      <T size={size} weight="semibold" tone={tone}>
        {children}
      </T>
    </Pressable>
  );
}

// ---------- Pills & badges ----------

export function Pill({ label, tone = 'neutral', icon, style }: { label: string; tone?: 'neutral' | 'accent' | 'blue' | 'green' | 'amber' | 'red'; icon?: string; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const [bg, fg] = {
    neutral: [c.line2, c.ink2],
    accent: [c.accentSoft, c.accentInk],
    blue: [c.blueSoft, c.blueInk],
    green: [c.greenSoft, c.green],
    amber: [c.amberSoft, c.amberInk],
    red: [c.redSoft, c.red],
  }[tone];
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: bg, alignSelf: 'flex-start' }, style]}>
      {icon && <Icon name={icon} size={11} color={fg} />}
      <T size={11} weight="bold" style={{ color: fg, lineHeight: 16 }}>
        {label}
      </T>
    </View>
  );
}

export const STATUS_TONE = { todo: 'neutral', in_progress: 'blue', blocked: 'red', review: 'amber', done: 'green' } as const;
const STATUS_TEXT: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done' };

export const StatusPill = ({ status }: { status: string }) => <Pill label={STATUS_TEXT[status] ?? status} tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? 'neutral'} />;

export function HealthPill({ health }: { health: string }) {
  const { c } = useTheme();
  const label: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
  const dot = { on_track: '#49a77a', at_risk: '#e3a33b', off_track: c.red }[health] ?? c.muted;
  return (
    <Row gap={5}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <T size={12} weight="semibold" tone="ink2">
        {label[health] ?? health}
      </T>
    </Row>
  );
}

export function Badge({ count, tone = 'accent' }: { count: number; tone?: 'accent' | 'muted' | 'red' }) {
  const { c } = useTheme();
  if (!count) return null;
  const bg = { accent: c.accent, muted: c.line2, red: c.red }[tone];
  const fg = tone === 'muted' ? c.ink2 : '#fff';
  return (
    <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <T size={10} weight="bold" style={{ color: fg, lineHeight: 13 }}>
        {count > 99 ? '99+' : count}
      </T>
    </View>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function ProgressBar({ value, color, height = 6, style }: { value: number; color?: string; height?: number; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: c.line2, overflow: 'hidden' }, style]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: color ?? c.accent }} />
    </View>
  );
}

/** A circular progress ring, like the web's goal and project rings. */
export function Ring({ value, size = 44, stroke = 5, color, label }: { value: number; size?: number; stroke?: number; color?: string; label?: string }) {
  const { c } = useTheme();
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.line2} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color ?? c.accent}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${(len * pct) / 100} ${len}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <T size={size > 50 ? 13 : 10} weight="bold">
        {label ?? `${Math.round(pct)}%`}
      </T>
    </View>
  );
}

// ---------- Avatars ----------

const AVATAR = { xs: 22, sm: 28, md: 36, lg: 48, xl: 72 } as const;

export function Avatar({
  user,
  size = 'md',
  presence = false,
}: {
  user: { id?: string; name: string; color?: string; status?: string } | null | undefined;
  size?: keyof typeof AVATAR;
  presence?: boolean;
}) {
  const { c } = useTheme();
  const px = AVATAR[size];
  if (!user)
    return (
      <View style={{ width: px, height: px, borderRadius: px / 2, backgroundColor: c.line2, alignItems: 'center', justifyContent: 'center' }}>
        <T size={px * 0.4} tone="muted">
          ?
        </T>
      </View>
    );
  const online = user.id ? realtime.online.has(user.id) : false;
  return (
    <View style={{ width: px, height: px }} accessibilityLabel={user.name}>
      <View style={{ width: px, height: px, borderRadius: px / 2, backgroundColor: swatch(user.color), alignItems: 'center', justifyContent: 'center' }}>
        <T size={Math.max(9, px * 0.38)} weight="bold" style={{ color: '#fff', lineHeight: px * 0.5 }}>
          {initials(user.name)}
        </T>
      </View>
      {presence && (
        <View
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: Math.max(9, px * 0.3),
            height: Math.max(9, px * 0.3),
            borderRadius: px,
            borderWidth: 2,
            borderColor: c.surface,
            backgroundColor: user.status === 'focus' ? c.accent2 : online ? '#55bf86' : c.dotAway,
          }}
        />
      )}
    </View>
  );
}

export function AvatarStack({ users, max = 3, total }: { users: { id?: string; name: string; color?: string }[]; max?: number; total?: number }) {
  const { c } = useTheme();
  const extra = (total ?? users.length) - Math.min(max, users.length);
  return (
    <Row gap={0}>
      {users.slice(0, max).map((u, i) => (
        <View key={u.id ?? i} style={{ marginLeft: i ? -6 : 0, borderRadius: 12, borderWidth: 2, borderColor: c.surface }}>
          <Avatar user={u} size="xs" />
        </View>
      ))}
      {extra > 0 && (
        <View style={{ marginLeft: -6, borderRadius: 12, borderWidth: 2, borderColor: c.surface }}>
          <Avatar user={{ name: `+ ${extra}`, color: 'lilac' }} size="xs" />
        </View>
      )}
    </Row>
  );
}

// ---------- States ----------

export function Loading({ label = 'Loading', inline }: { label?: string; inline?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={inline ? { padding: 16, alignItems: 'center' } : { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', backgroundColor: c.canvas }} accessibilityLabel={`${label}…`}>
      <ActivityIndicator color={c.accent} />
    </View>
  );
}

export function Empty({ icon = 'spark', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16, gap: 8 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={22} color={c.accentInk} />
      </View>
      <T weight="bold" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {children ? typeof children === 'string' ? <Muted style={{ textAlign: 'center' }}>{children}</Muted> : children : null}
      {action && <View style={{ marginTop: 6 }}>{action}</View>}
    </View>
  );
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8, backgroundColor: c.canvas }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.redSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="alert" size={22} color={c.red} />
      </View>
      <T weight="bold" style={{ textAlign: 'center' }}>
        {(error as { status?: number }).status === 404 ? 'Not found, or you do not have access' : 'Could not load this'}
      </T>
      <Muted style={{ textAlign: 'center' }}>{error.message}</Muted>
      {retry && <Button title="Try again" onPress={retry} small />}
    </View>
  );
}

/** Loading / error / content in one line. */
export function Load<T>({ data, error, reload, children }: { data: T | undefined; error: Error | null; reload?: () => void; children: (data: T) => ReactNode }) {
  if (error && data === undefined) return <ErrorState error={error} retry={reload} />;
  if (data === undefined) return <Loading />;
  return <>{children(data)}</>;
}

// ---------- Forms ----------

const FieldLabel = createContext<string | undefined>(undefined);

export function Field({ label, children, hint, style }: { label: string; children: ReactNode; hint?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <T size={13} weight="semibold" tone="ink2" importantForAccessibility="no">
        {label}
      </T>
      <FieldLabel.Provider value={label}>{children}</FieldLabel.Provider>
      {!!hint && <Muted size={12}>{hint}</Muted>}
    </View>
  );
}

export function Input({ style, multiline, ...props }: TextInputProps & { style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  const fieldLabel = useContext(FieldLabel);
  const [focus, setFocus] = useState(false);
  return (
    <TextInput
      placeholderTextColor={c.muted}
      accessibilityLabel={fieldLabel ?? props.placeholder}
      {...props}
      multiline={multiline}
      onFocus={(e) => {
        setFocus(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        props.onBlur?.(e);
      }}
      style={[
        {
          minHeight: multiline ? 96 : 46,
          borderWidth: 1,
          borderColor: focus ? c.accent : c.lineStrong,
          borderRadius: 11,
          paddingHorizontal: 13,
          paddingVertical: multiline ? 11 : 0,
          backgroundColor: c.surface,
          color: c.ink,
          fontFamily: fonts.body,
          fontSize: 16,
          textAlignVertical: multiline ? 'top' : 'center',
        },
        style,
      ]}
    />
  );
}

export function PasswordInput(props: TextInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <View>
      <Input {...props} secureTextEntry={!shown} autoCapitalize="none" autoCorrect={false} style={{ paddingRight: 46 }} />
      <View style={{ position: 'absolute', right: 4, top: 3 }}>
        <IconButton name="eye" label={shown ? 'Hide password' : 'Show password'} onPress={() => setShown((v) => !v)} size={18} />
      </View>
    </View>
  );
}

export function SearchBox({ value, onChangeText, placeholder = 'Search', autoFocus }: { value: string; onChangeText: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 11, paddingHorizontal: 12, height: 42 }}>
      <Icon name="search" size={17} color={c.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.muted}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={placeholder}
        style={{ flex: 1, color: c.ink, fontFamily: fonts.body, fontSize: 15, height: 40 }}
      />
      {!!value && <IconButton name="x" label="Clear" size={15} onPress={() => onChangeText('')} />}
    </View>
  );
}

export function Toggle({ value, onChange, label, hint, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const { c } = useTheme();
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, { toValue: value ? 1 : 0, duration: 160, useNativeDriver: false }).start();
  }, [value, x]);
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}
    >
      <View style={{ flex: 1 }}>
        <T weight="semibold">{label}</T>
        {!!hint && <Muted>{hint}</Muted>}
      </View>
      <Animated.View
        style={{
          width: 46,
          height: 28,
          borderRadius: 14,
          padding: 3,
          backgroundColor: x.interpolate({ inputRange: [0, 1], outputRange: [c.lineStrong, c.accent] }),
        }}
      >
        <Animated.View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }] }} />
      </Animated.View>
    </Pressable>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => !disabled && onChange?.(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      hitSlop={6}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: disabled ? 0.6 : 1 }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          borderWidth: 1.5,
          borderColor: checked ? c.accent : c.lineStrong,
          backgroundColor: checked ? c.accent : c.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Icon name="check" size={14} color="#fff" strokeWidth={2.6} />}
      </View>
      {typeof label === 'string' ? <T style={{ flexShrink: 1 }}>{label}</T> : label}
    </Pressable>
  );
}

/** Chips in a horizontal row, one selected: the mobile version of the web's tab bar. */
export function Tabs<V extends string>({ tabs, value, onChange, style }: { tabs: { id: V; label: string; count?: number }[]; value: V; onChange: (v: V) => void; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]} contentContainerStyle={{ gap: 6, paddingRight: 8 }} accessibilityRole="tablist">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <Pressable
            key={t.id}
            onPress={() => onChange(t.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 13,
              height: 34,
              borderRadius: radius.pill,
              backgroundColor: on ? c.ink : c.surface,
              borderWidth: 1,
              borderColor: on ? c.ink : c.line,
            }}
          >
            <T size={13} weight="bold" style={{ color: on ? c.canvas : c.ink2 }}>
              {t.label}
            </T>
            {!!t.count && (
              <T size={11} weight="bold" style={{ color: on ? c.canvas : c.muted }}>
                {t.count}
              </T>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Equal-width segmented control, for 2–4 short choices. */
export function Segmented<V extends string>({ options, value, onChange }: { options: { id: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.line2, borderRadius: 11, padding: 3 }} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{ flex: 1, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.surface : 'transparent' }}
          >
            <T size={13} weight="bold" tone={on ? 'ink' : 'muted'}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- Sheets ----------

/** A bottom sheet: the phone's version of the web's modal dialogs. */
export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  full,
  scroll = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  full?: boolean;
  scroll?: boolean;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} accessibilityLabel="Close" />
        <View
          style={{
            backgroundColor: c.canvas,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: full ? '94%' : '88%',
            minHeight: full ? '94%' : undefined,
            paddingBottom: Math.max(insets.bottom, 12),
          }}
          accessibilityViewIsModal
        >
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: c.lineStrong }} />
          </View>
          {(title || eyebrow) && (
            <Row style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6, justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
                {title && <H2 style={{ fontSize: 19 }}>{title}</H2>}
              </View>
              <IconButton name="x" label="Close" onPress={onClose} />
            </Row>
          )}
          {scroll ? (
            <ScrollView contentContainerStyle={{ padding: 18, paddingTop: 8, gap: 14 }} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
          ) : (
            <View style={{ flex: 1, padding: 18, paddingTop: 8 }}>{children}</View>
          )}
          {footer && <View style={{ paddingHorizontal: 18, paddingTop: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.line }}>{footer}</View>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface ActionItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onPress: () => void;
  hidden?: boolean;
}

/** A list of actions in a sheet: the phone's version of the web's "…" menus. */
export function ActionSheet({ open, onClose, title, actions }: { open: boolean; onClose: () => void; title?: string; actions: ActionItem[] }) {
  const { c } = useTheme();
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <View>
        {actions
          .filter((a) => !a.hidden)
          .map((a) => (
            <ListRow
              key={a.label}
              title={
                <T weight="semibold" tone={a.danger ? 'red' : 'ink'}>
                  {a.label}
                </T>
              }
              left={a.icon ? <Icon name={a.icon} size={19} color={a.danger ? c.red : c.ink2} /> : undefined}
              onPress={() => {
                onClose();
                // Let the sheet close before the action opens anything else.
                setTimeout(a.onPress, Platform.OS === 'ios' ? 350 : 50);
              }}
            />
          ))}
      </View>
    </Sheet>
  );
}

/** A "pick one" control that opens a sheet of options. */
export function Select<V extends string>({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  title,
  disabled,
}: {
  value: V | null | undefined;
  options: { id: V; label: string; hint?: string; left?: ReactNode }[];
  onChange: (v: V) => void;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  return (
    <>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={title ?? placeholder}
        accessibilityValue={{ text: current?.label }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, borderWidth: 1, borderColor: c.lineStrong, borderRadius: 11, paddingHorizontal: 13, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }}
      >
        {current?.left}
        <T style={{ flex: 1 }} tone={current ? 'ink' : 'muted'} numberOfLines={1}>
          {current?.label ?? placeholder}
        </T>
        <Icon name="chevronDown" size={18} color={c.muted} />
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={title ?? placeholder}>
        <View>
          {options.map((o) => (
            <ListRow
              key={o.id}
              title={o.label}
              subtitle={o.hint}
              left={o.left}
              right={o.id === value ? <Icon name="check" size={18} color={c.accent} /> : undefined}
              onPress={() => {
                setOpen(false);
                onChange(o.id);
              }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

// ---------- Toasts & actions ----------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}
const ToastContext = createContext<(text: string, tone?: 'info' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, top: insets.top + 8, gap: 6, alignItems: 'center' }} accessibilityLiveRegion="polite">
        {toasts.map((t) => (
          <View
            key={t.id}
            style={{
              backgroundColor: t.tone === 'error' ? c.red : c.nav,
              borderRadius: 12,
              paddingHorizontal: 16,
              paddingVertical: 11,
              maxWidth: 520,
              shadowColor: '#000',
              shadowOpacity: 0.2,
              shadowRadius: 12,
              elevation: 4,
            }}
          >
            <T size={14} weight="semibold" style={{ color: '#fff' }}>
              {t.text}
            </T>
          </View>
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Wrap an async action: show API errors as toasts. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <R,>(fn: () => Promise<R>, success?: string): Promise<R | undefined> => {
      try {
        const result = await fn();
        if (success) toast(success);
        return result;
      } catch (e) {
        toast((e as Error).message || 'Something went wrong', 'error');
        return undefined;
      }
    },
    [toast],
  );
}

/** Ask before doing something destructive. Resolves true when confirmed. */
export function confirm(title: string, message?: string, confirmLabel = 'OK', destructive = true): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(globalThis.confirm?.(message ? `${title}\n\n${message}` : title) ?? false);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]),
  );
}

/** Ask for a line of text (iOS has a native prompt; elsewhere a sheet is used by callers). */
export function PromptSheet({
  open,
  onClose,
  title,
  label,
  initial = '',
  placeholder,
  submitLabel = 'Save',
  multiline,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  multiline?: boolean;
  onSubmit: (value: string) => Promise<unknown> | void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <Button
          title={submitLabel}
          variant="primary"
          full
          disabled={!value.trim()}
          onPress={async () => {
            await onSubmit(value.trim());
          }}
        />
      }
    >
      <Field label={label ?? title}>
        <Input value={value} onChangeText={setValue} placeholder={placeholder} autoFocus multiline={multiline} />
      </Field>
    </Sheet>
  );
}

// ---------- Brand ----------

export function Logo({ height = 28, onDark = false }: { height?: number; onDark?: boolean }) {
  const color = onDark ? '#fef6eb' : '#b5461b';
  return (
    <Svg viewBox="318 290 874 356" height={height} width={(height * 874) / 356} accessibilityLabel="Küü">
      <Path d="M377 345V588" stroke={color} strokeWidth={94} strokeLinecap="round" fill="none" />
      <Path d="M436 468L588 340M470 498L597 594" stroke={color} strokeWidth={80} strokeLinecap="round" fill="none" />
      <Path d="M683 448V505A85 85 0 0 0 853 505V448" stroke={color} strokeWidth={84} strokeLinecap="round" fill="none" />
      <Path d="M967 448V505A85 85 0 0 0 1137 505V448" stroke={color} strokeWidth={84} strokeLinecap="round" fill="none" />
      {[709, 827, 991, 1103].map((cx) => (
        <Circle key={cx} cx={cx} cy={342} r={42} fill="#ea9c5e" />
      ))}
    </Svg>
  );
}

export type { PressableProps };
