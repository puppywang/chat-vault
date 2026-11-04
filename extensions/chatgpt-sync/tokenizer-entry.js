import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

let encoding;

export function countTexts(texts) {
  encoding ||= new Tiktoken(o200kBase);
  return texts.reduce((sum, text) => sum + encoding.encode(text).length, 0);
}
