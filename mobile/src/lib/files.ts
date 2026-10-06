import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { apiUrl, authHeaders, type PickedFile } from './api';

/** Pick one or more files from the phone (documents, PDFs, anything). */
export async function pickDocuments(multiple = false): Promise<PickedFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return res.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? 'application/octet-stream', file: a.file }));
}

/** Pick photos or videos from the library, or take one with the camera. */
export async function pickMedia(source: 'library' | 'camera' = 'library', multiple = false): Promise<PickedFile[]> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Allow camera access in Settings to take photos.');
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images', 'videos'], quality: 0.85, allowsMultipleSelection: multiple };
  const res = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (res.canceled) return [];
  return res.assets.map((a, i) => {
    const ext = a.mimeType?.split('/')[1]?.replace('jpeg', 'jpg') ?? (a.type === 'video' ? 'mp4' : 'jpg');
    return { uri: a.uri, name: a.fileName ?? `${a.type === 'video' ? 'video' : 'photo'}-${Date.now()}-${i}.${ext}`, type: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'), file: a.file };
  });
}

const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';

/** Download a stored file with this session's credentials and open the system share / preview sheet. */
export async function openStoredFile(id: string, name: string) {
  const url = apiUrl(`/files/${id}/download`);
  if (Platform.OS === 'web') {
    globalThis.open?.(url, '_blank', 'noopener');
    return;
  }
  const dir = new Directory(Paths.cache, 'kuu-files', id);
  dir.create({ intermediates: true, idempotent: true });
  const file = await File.downloadFileAsync(url, new File(dir, safeName(name)), { headers: authHeaders(), idempotent: true });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { dialogTitle: name });
}

/** URL + headers for showing a stored image or playing media inline. */
export const fileSource = (id: string, inline = true) => ({ uri: apiUrl(`/files/${id}/download${inline ? '?inline=1' : ''}`), headers: authHeaders() });

export const isImage = (mime: string | null | undefined, name = '') => /^image\/(png|jpe?g|gif|webp)$/i.test(mime ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(name);
export const isVideo = (mime: string | null | undefined, name = '') => /^video\//i.test(mime ?? '') || /\.(mp4|mov|webm|m4v)$/i.test(name);
export const isAudio = (mime: string | null | undefined, name = '') => /^audio\//i.test(mime ?? '') || /\.(m4a|mp3|wav|ogg|webm|aac)$/i.test(name);
