import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface RegistryProject {
  dir: string
  baseBranch: string
  registeredAt: string
}

interface RegistryFile {
  projects: RegistryProject[]
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'code-review-annotator')
}

function registryPath(): string {
  return path.join(configDir(), 'projects.json')
}

function read(): RegistryFile {
  const p = registryPath()
  if (!fs.existsSync(p)) return { projects: [] }
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const data = JSON.parse(raw) as Partial<RegistryFile>
    return { projects: Array.isArray(data.projects) ? data.projects : [] }
  } catch {
    return { projects: [] }
  }
}

function write(data: RegistryFile): void {
  const p = registryPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
}

export function registerProject(dir: string, baseBranch: string): void {
  const abs = path.resolve(dir)
  const data = read()
  const existing = data.projects.find(p => p.dir === abs)
  const now = new Date().toISOString()
  if (existing) {
    existing.baseBranch = baseBranch
    existing.registeredAt = now
  } else {
    data.projects.push({ dir: abs, baseBranch, registeredAt: now })
  }
  write(data)
}

export function listProjects(): RegistryProject[] {
  return read().projects.filter(p => fs.existsSync(p.dir))
}

export function findProject(dir: string): RegistryProject | null {
  const abs = path.resolve(dir)
  return read().projects.find(p => p.dir === abs) ?? null
}
