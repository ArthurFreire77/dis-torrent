// Entrada do runner: `node --test` trata um diretório como módulo executável,
// então este index importa os suites para que `tests/` rode com 0 fail.
// Cada *.test.ts também roda isolado: node --test --experimental-strip-types tests/<arq>.test.ts
import './callPhases.test.ts'
import './botCommands.test.ts'
import './downloadQueue.test.ts'
import './screenShare.test.ts'
