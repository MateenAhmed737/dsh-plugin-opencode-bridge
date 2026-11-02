// A stand-in DSH host: starts the runtime, prints the pids, then waits to be killed.
import { makeRuntime } from '../helpers.ts'

const runtime = makeRuntime({ version: process.argv[2] ?? '1.15.0', log: process.argv[3]! })
await runtime.connect()
process.stdout.write('ready\n')
setInterval(() => {}, 1000)
