import { createInterface } from 'readline'
import { Writable } from 'stream'

/** Ask a question; when `hidden`, typed characters are not echoed. */
export function prompt(question: string, hidden = false): Promise<string> {
  let muted = false
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY === true })
  return new Promise((resolve, reject) => {
    rl.on('close', () => resolve(''))
    process.stdout.write(question)
    muted = hidden
    rl.question('', (answer) => {
      muted = false
      if (hidden) process.stdout.write('\n')
      rl.removeAllListeners('close')
      rl.close()
      resolve(answer)
    })
    rl.on('error', reject)
  })
}
