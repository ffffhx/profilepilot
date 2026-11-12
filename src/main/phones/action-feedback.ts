import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PhoneActionResult } from '../../shared/phones';

/** Keep binary images out of CLI text; a file error cannot turn input into failure. */
export async function savePhoneFeedbackImage(value: PhoneActionResult, output?: string, home = os.homedir()): Promise<PhoneActionResult> {
  const image = value.observation as { base64?: string; mime?: string } | undefined;
  if (value.actionOutcome !== 'completed' || typeof image?.base64 !== 'string') return value;
  try {
    if (image.mime !== 'image/png') throw new Error('Invalid image');
    const destination = output ? path.resolve(output) : path.join(home, '.profilepilot', 'phone', 'artifacts', randomUUID() + '.png');
    if (!output) await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.from(image.base64, 'base64'), { flag: 'wx', mode: 0o600 });
    const { base64, ...metadata } = image;
    return { ...value, observation: { ...metadata, path: destination } };
  } catch {
    return { ...value, observationStatus: 'unavailable', observation: undefined, nextStep: 'observe-or-check-control',
      observationError: { code: 'PHONE_OBSERVATION_WRITE_FAILED', message: '动作已执行，但操作后的截图未保存。请重新截图，不要重复动作。' } };
  }
}
