// lib0 (used by yjs) imports `lib0/webcrypto`, whose react-native build needs isomorphic-webcrypto.
// Yjs only needs secure random numbers, so metro.config.js points that import here instead.
import { getRandomValues as fill } from 'expo-crypto';

export const subtle = undefined;
export const getRandomValues = (array) => fill(array);
