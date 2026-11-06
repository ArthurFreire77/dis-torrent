// Insere a seção 1.1.61 no topo do CHANGELOG preservando bytes e LF do git.
// O PowerShell 5.1 grava em ANSI/CRLF e já truncou o arquivo numa tentativa.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const base = execFileSync('git', ['show', 'HEAD~1:CHANGELOG.md'], { encoding: 'utf8' })
if (!base.startsWith('# CHANGELOG\n')) throw new Error('cabeçalho inesperado: ' + base.slice(0, 40))
const marca = '## [1.1.60-pre-alpha]'
const idx = base.indexOf(marca)
if (idx < 0) throw new Error('nao achei a secao 1.1.60')

const nova = readFileSync('.git/CHANGELOG_NEW.md', 'utf8').replace(/\r\n/g, '\n')
const out = base.slice(0, idx) + nova.trimEnd() + '\n\n' + base.slice(idx)
writeFileSync('CHANGELOG.md', out, 'utf8')

const linhas = out.split('\n')
console.log('linhas:', linhas.length)
console.log('secoes:', linhas.filter((l) => l.startsWith('## [')).length)
console.log('CRLF:', out.includes('\r\n'))
console.log('primeira secao:', linhas.find((l) => l.startsWith('## [')))
console.log('1.1.60 presente:', out.includes(marca))
