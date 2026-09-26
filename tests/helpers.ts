import { registerBuiltinComponents } from '../src/components/builtin';
import { Editor } from '../src/core/Editor';
import { createProject } from '../src/core/project';

export function makeEditor(sample = false): Editor {
  registerBuiltinComponents();
  return new Editor(createProject('テスト', sample));
}
