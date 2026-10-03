import { customAlphabet } from 'nanoid';

// 128 random bits, retaining the hex format used by sync placeholders.
export const randomId = customAlphabet('0123456789abcdef', 32);
