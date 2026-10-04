// Entrada do runner de testes unitários (node:test).
//
// Por que este arquivo existe: `node --test` trata um diretório como módulo
// executável e não pega `*.ts` sozinho, então importamos cada suite aqui para
// que `npm run test:unit` rode com 0 falhas.
//
// Cada suite também roda isolado, útil pra depurar uma só:
//   node --experimental-strip-types --test tests/<arquivo>.test.ts
import './botCommands.test.ts'
import './callPhases.test.ts'
import './channels.test.ts'
import './downloadQueue.test.ts'
import './screenShare.test.ts'