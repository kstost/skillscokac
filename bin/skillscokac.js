#!/usr/bin/env node

const { Command } = require('commander')
const axios = require('axios')
const inquirer = require('inquirer')
const fs = require('fs')
const path = require('path')
const os = require('os')
const chalk = require('chalk')
const ora = require('ora')
const yaml = require('yaml')
const AdmZip = require('adm-zip')
const boxen = require('boxen')

const packageJson = require(path.join(__dirname, '..', 'package.json'))
const VERSION = packageJson.version
const API_BASE_URL = 'https://skills.cokac.com'
const MAX_ZIP_SIZE = 50 * 1024 * 1024
const MAX_FILE_SIZE = 5 * 1024 * 1024
const AXIOS_TIMEOUT = 30000
const DEBUG = false;
const DEBUG_LOG_FILE = path.join(process.cwd(), 'debug.log')

function debugLog(operation, filePath, metadata = {}) {
  if (!DEBUG) return
  try {
    const logEntry = { timestamp: new Date().toISOString(), operation, path: path.resolve(filePath), ...metadata }
    fs.appendFileSync(DEBUG_LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf8')
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Failed to write to debug log: ${error.message}`))
  }
}

function validateSkillName(skillName) {
  if (!skillName || typeof skillName !== 'string') throw new Error('Invalid skill name')
  const trimmed = skillName.trim()
  if (trimmed.length === 0) throw new Error('Skill name cannot be empty')
  if (trimmed.length > 64) throw new Error('Skill name too long (max 64 characters)')
  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    if (/[A-Z]/.test(trimmed)) throw new Error('Skill name must contain only lowercase letters (no uppercase allowed)')
    if (/_/.test(trimmed)) throw new Error('Skill name cannot contain underscores (use hyphens instead)')
    if (/\s/.test(trimmed)) throw new Error('Skill name cannot contain spaces')
    throw new Error('Skill name must contain only lowercase letters, numbers, and hyphens')
  }
  if (trimmed.startsWith('-')) throw new Error('Skill name cannot start with a hyphen')
  if (trimmed.endsWith('-')) throw new Error('Skill name cannot end with a hyphen')
  if (trimmed.includes('--')) throw new Error('Skill name cannot contain consecutive hyphens')
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new Error('Skill name cannot contain path separators')
  if (trimmed.includes('..')) throw new Error('Skill name cannot contain ".."')
  if (trimmed.startsWith('.')) throw new Error('Skill name cannot start with a dot')
  if (trimmed.includes('\0')) throw new Error('Skill name cannot contain null bytes')
  if (!/^[a-z0-9]/.test(trimmed)) throw new Error('Skill name must start with a letter or number')
  if (!/[a-z0-9]$/.test(trimmed)) throw new Error('Skill name must end with a letter or number')
  return trimmed
}

function validateSkillNameOrExit(skillName) {
  try {
    return validateSkillName(skillName)
  } catch (error) {
    console.log(chalk.red(`✗ ${error.message}`))
    process.exit(1)
  }
}

function validateSkillDirectory(skillDir, skillName) {
  if (skillName) validateSkillName(skillName)
  const resolvedDir = path.resolve(skillDir)
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills')
  const isInPersonal = resolvedDir.startsWith(personalSkillsDir + path.sep) || resolvedDir === personalSkillsDir
  const isInProject = resolvedDir.startsWith(projectSkillsDir + path.sep) || resolvedDir === projectSkillsDir
  if (!isInPersonal && !isInProject) throw new Error(`Security: Skill directory must be within .claude/skills (personal or project)`)
  if (skillName && !resolvedDir.endsWith(path.join('.claude', 'skills', skillName))) {
    throw new Error(`Security: Skill directory path must be .claude/skills/${skillName}`)
  }
  return resolvedDir
}

function preprocessFrontmatter(frontmatterText) {
  const lines = frontmatterText.split('\n')
  if (lines.length > 1000) throw new Error('Frontmatter too complex (max 1000 lines)')
  const processedLines = []
  for (const line of lines) {
    if (line.length > 2000) throw new Error('Frontmatter line too long (max 2000 characters)')
    if (!line.trim() || line.trim().startsWith('#')) {
      processedLines.push(line)
      continue
    }
    const match = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_-]*):\s*([^\n\r]{0,1500})$/)
    if (!match || match.length !== 4) {
      processedLines.push(line)
      continue
    }
    const indent = match[1], key = match[2], value = match[3]
    if (!value.trim()) {
      processedLines.push(line)
      continue
    }
    const trimmedValue = value.trim()
    if ((trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) || (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))) {
      processedLines.push(line)
      continue
    }
    if (trimmedValue === '|' || trimmedValue === '>') {
      processedLines.push(line)
      continue
    }
    if (trimmedValue.startsWith('[') || trimmedValue.startsWith('{')) {
      processedLines.push(line)
      continue
    }
    const needsQuoting = /[:{}[\]|>@`&*!%#]/.test(value)
    if (needsQuoting) {
      let escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
      processedLines.push(`${indent}${key}: "${escapedValue}"`)
    } else {
      processedLines.push(line)
    }
  }
  return processedLines.join('\n')
}

function isWithIn(checkPath, base) {
  return checkPath.startsWith(base + path.sep) || checkPath === base;
}

function isWithInClaudeSkill(resolvedBase) {
  const expectedPersonalPath = path.resolve(os.homedir(), '.claude', 'skills');// + path.sep;
  const expectedProjectPath = path.resolve(process.cwd(), '.claude', 'skills');// + path.sep;
  return isWithIn(resolvedBase, expectedPersonalPath) || isWithIn(resolvedBase, expectedProjectPath);
}

function validatePathWithinBase(targetPath, baseDir, enforceClaudeSkills = true) {
  try {
    const resolvedTarget = path.resolve(targetPath)
    const resolvedBase = path.resolve(baseDir)
    const isWithinBase = isWithIn(resolvedTarget, resolvedBase);
    if (!isWithinBase) return false;
    if (!enforceClaudeSkills) return true;
    if (!isWithInClaudeSkill(resolvedBase)) return false;
    return true;
  } catch (error) {
    return false
  }
}

function safeWriteFile(filePath, content, baseDir, enforceClaudeSkills = true) {
  if (enforceClaudeSkills && !isWithInClaudeSkill(filePath)) {
    throw new Error(`Security: Rejected unsafe file path: ${filePath}`)
  }
  if (!validatePathWithinBase(filePath, baseDir, enforceClaudeSkills)) {
    debugLog('WRITE_REJECTED', filePath, { reason: 'Path validation failed', baseDir })
    throw new Error(`Security: Rejected unsafe file path: ${filePath}`)
  }
  const fileDir = path.dirname(filePath)
  if (fs.existsSync(fileDir)) {
    const stats = fs.lstatSync(fileDir)
    if (stats.isSymbolicLink()) {
      debugLog('WRITE_REJECTED', filePath, { reason: 'Symlink directory', fileDir })
      throw new Error(`Security: Cannot write to symlink directory: ${fileDir}`)
    }
  }
  if (content && content.length > MAX_FILE_SIZE) {
    debugLog('WRITE_REJECTED', filePath, { reason: 'Content too large', size: content.length })
    throw new Error(`File content too large (${Math.round(content.length / 1024)}KB). Maximum: ${Math.round(MAX_FILE_SIZE / 1024)}KB`)
  }
  const fileExists = fs.existsSync(filePath)
  const operation = fileExists ? 'MODIFY' : 'CREATE'
  debugLog('FS_MKDIR', fileDir, { recursive: true, baseDir, enforceClaudeSkills })
  fs.mkdirSync(fileDir, { recursive: true })
  debugLog('FS_WRITE', filePath, { contentSize: content ? content.length : 0, baseDir, enforceClaudeSkills })
  fs.writeFileSync(filePath, content || '', 'utf8')
  debugLog(operation, filePath, { baseDir, contentSize: content ? content.length : 0, enforceClaudeSkills })
}

function safeRemoveDirectory(dirPath, skillNameOrBaseDir, isSkillDirectory = true) {
  const resolvedPath = path.resolve(dirPath)
  if (isSkillDirectory) {
    const skillName = skillNameOrBaseDir
    validateSkillName(skillName)
    if (!isWithInClaudeSkill(resolvedPath)) {
      throw new Error(`Security: Rejected unsafe file path: ${resolvedPath}`)
    }
    if (!resolvedPath.endsWith(skillName)) {
      debugLog('DELETE_REJECTED', resolvedPath, { reason: 'Path does not end with skill name', skillName })
      throw new Error(`Security: Directory path must end with skill name: ${skillName}`)
    }
    if (!resolvedPath.includes(path.join('.claude', 'skills', skillName))) {
      debugLog('DELETE_REJECTED', resolvedPath, { reason: 'Path not in .claude/skills', skillName })
      throw new Error(`Security: Directory must be within .claude/skills/${skillName}`)
    }
    const expectedPersonalPath = path.resolve(os.homedir(), '.claude', 'skills', skillName)
    const expectedProjectPath = path.resolve(process.cwd(), '.claude', 'skills', skillName)
    if (resolvedPath !== expectedPersonalPath && resolvedPath !== expectedProjectPath) {
      debugLog('DELETE_REJECTED', resolvedPath, { reason: 'Unexpected path', resolvedPath, expectedPersonalPath, expectedProjectPath })
      throw new Error(`Security: Unexpected directory path: ${resolvedPath}`)
    }
  } else {
    const baseDir = skillNameOrBaseDir
    if (!validatePathWithinBase(resolvedPath, baseDir, false)) {
      debugLog('DELETE_REJECTED', resolvedPath, { reason: 'Path validation failed', baseDir })
      throw new Error(`Security: Rejected unsafe directory path: ${resolvedPath}`)
    }
  }
  if (fs.existsSync(resolvedPath)) {
    const stats = fs.lstatSync(resolvedPath)
    if (stats.isSymbolicLink()) {
      debugLog('DELETE_REJECTED', resolvedPath, { reason: 'Symlink', resolvedPath })
      throw new Error(`Security: Cannot remove symlink: ${resolvedPath}`)
    }
  }
  if (fs.existsSync(resolvedPath)) {
    let fileCount = 0
    try {
      const countFiles = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            countFiles(path.join(dir, entry.name))
          } else {
            fileCount++
          }
        }
      }
      countFiles(resolvedPath)
    } catch (e) { }
    debugLog('FS_RM', resolvedPath, { recursive: true, fileCount })
    fs.rmSync(resolvedPath, { recursive: true })
    debugLog('DELETE', resolvedPath, {
      skillName: isSkillDirectory ? skillNameOrBaseDir : undefined,
      baseDir: !isSkillDirectory ? skillNameOrBaseDir : undefined,
      type: isSkillDirectory ? 'skill-directory' : 'generic-directory',
      fileCount
    })
  }
}

function safeCreateDirectory(dirPath, baseDir, enforceClaudeSkills = true) {
  if (!validatePathWithinBase(dirPath, baseDir, enforceClaudeSkills)) {
    debugLog('CREATE_DIR_REJECTED', dirPath, { reason: 'Path validation failed', baseDir })
    throw new Error(`Security: Rejected unsafe directory path: ${dirPath}`)
  }
  const dirExists = fs.existsSync(dirPath)
  debugLog('FS_MKDIR', dirPath, { recursive: true, baseDir, enforceClaudeSkills })
  fs.mkdirSync(dirPath, { recursive: true })
  if (!dirExists) debugLog('CREATE_DIR', dirPath, { baseDir, enforceClaudeSkills })
}

function normalizeUntrustedPath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid file path')
  let normalized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/')
  normalized = normalized.replace(/^\/+/, '')
  if (normalized.includes('..')) throw new Error(`Invalid path contains ..: ${filePath}`)
  if (path.isAbsolute(normalized)) throw new Error(`Absolute paths not allowed: ${filePath}`)
  return normalized
}

function parseFrontmatter(content) {
  const normalizedContent = content.replace(/\r\n/g, '\n')
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/
  const match = normalizedContent.match(frontmatterRegex)
  if (!match) return { metadata: {}, content: normalizedContent }
  try {
    if (match[1].length > 10000) throw new Error('Frontmatter too large (max 10KB)')
    const preprocessed = preprocessFrontmatter(match[1])
    const metadata = yaml.parse(preprocessed, { maxAliasCount: 10, strict: true, uniqueKeys: true, version: '1.2' })
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      throw new Error('Invalid frontmatter: must be an object')
    }
    const markdownContent = normalizedContent.slice(match[0].length).trim()
    return { metadata, content: markdownContent }
  } catch (error) {
    console.error(chalk.red('Error parsing frontmatter:'), error.message)
    return { metadata: {}, content: normalizedContent }
  }
}

function displaySkillInfo(skill) {
  const { metadata } = parseFrontmatter(skill.skillMd || '')
  const displayName = metadata.name || skill.skillName
  console.log(chalk.bold.cyan(`/${skill.skillName}`) + (displayName !== skill.skillName ? chalk.dim(` (${displayName})`) : ''))
  if (metadata.description) console.log(chalk.dim(metadata.description))
  const metaItems = []
  if (skill.author) metaItems.push(chalk.dim('Author: ') + chalk.white(skill.author.name || skill.author.username))
  const totalFiles = 1 + (skill.files ? skill.files.length : 0)
  metaItems.push(chalk.dim('Files: ') + chalk.white(`${totalFiles} file${totalFiles !== 1 ? 's' : ''}`))
  if (skill.version) metaItems.push(chalk.dim('Version: ') + chalk.white(skill.version))
  console.log('  ' + metaItems.join(chalk.dim(' • ')))
}

async function fetchSkill(skillName, options = {}) {
  const silent = options.silent || false
  const spinner = silent ? null : ora(`Searching for skill: ${skillName}`).start()
  try {
    skillName = validateSkillName(skillName)
    if (spinner) spinner.text = 'Fetching marketplace data...'
    const marketplaceResponse = await axios.get(`${API_BASE_URL}/api/marketplace`, {
      headers: { 'User-Agent': `skillscokac-cli/${VERSION}` },
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (status) => status === 200
    })
    const contentType = marketplaceResponse.headers['content-type']
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Invalid response type from server (expected JSON)')
    }
    const marketplace = marketplaceResponse.data
    if (!marketplace || typeof marketplace !== 'object') throw new Error('Invalid marketplace data received')
    if (!Array.isArray(marketplace.plugins)) throw new Error('Invalid marketplace data: plugins not found')
    const plugin = marketplace.plugins.find(p => p && p.name === skillName)
    if (!plugin) throw new Error(`Skill "${skillName}" not found`)
    if (!plugin.source || !plugin.source.url) throw new Error('Invalid skill data: missing source URL')
    const postIdMatch = plugin.source.url.match(/\/plugins\/([^/.]+)/)
    if (!postIdMatch) throw new Error('Failed to parse skill URL')
    const postId = postIdMatch[1]
    if (spinner) spinner.text = 'Downloading skill files...'
    const zipResponse = await axios.get(`${API_BASE_URL}/api/posts/${postId}/export-skill-zip`, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': `skillscokac-cli/${VERSION}` },
      timeout: AXIOS_TIMEOUT,
      maxContentLength: MAX_ZIP_SIZE
    })
    const zipSize = zipResponse.data.byteLength
    if (zipSize > MAX_ZIP_SIZE) {
      throw new Error(`Skill package too large (${Math.round(zipSize / 1024 / 1024)}MB). Maximum: ${Math.round(MAX_ZIP_SIZE / 1024 / 1024)}MB`)
    }
    if (spinner) spinner.text = 'Extracting files...'
    const zip = new AdmZip(Buffer.from(zipResponse.data))
    const zipEntries = zip.getEntries()
    const MAX_FILES = 1000
    if (zipEntries.length > MAX_FILES) {
      throw new Error(`ZIP contains too many files (${zipEntries.length}). Maximum: ${MAX_FILES}`)
    }
    let totalSize = 0
    const MAX_COMPRESSION_RATIO = 1250
    const MAX_PATH_LENGTH = 255
    for (const entry of zipEntries) {
      const entryName = entry.entryName
      if (entryName.length > MAX_PATH_LENGTH) {
        throw new Error(`File path too long in ZIP: ${entryName.substring(0, 50)}... (${entryName.length} chars)`)
      }
      if (path.isAbsolute(entryName)) throw new Error(`Invalid zip entry: absolute path not allowed: ${entryName}`)
      const normalized = path.normalize(entryName).replace(/\\/g, '/')
      if (normalized.includes('..') || normalized.startsWith('.')) {
        throw new Error(`Invalid zip entry: path traversal detected: ${entryName}`)
      }
      if (entryName.includes('\0')) throw new Error('Invalid zip entry: null byte in filename')
      if (!entry.isDirectory) {
        const uncompressedSize = entry.header.size
        const compressedSize = entry.header.compressedSize
        if (uncompressedSize > MAX_FILE_SIZE * 2) {
          throw new Error(`File too large in package: ${entryName} (${Math.round(uncompressedSize / 1024 / 1024)}MB)`)
        }
        if (compressedSize > 0) {
          const ratio = uncompressedSize / compressedSize
          if (ratio > MAX_COMPRESSION_RATIO) {
            throw new Error(`Suspicious compression ratio detected in ${entryName} (possible zip bomb)`)
          }
        }
        totalSize += uncompressedSize
        if (totalSize > MAX_ZIP_SIZE * 2) throw new Error('Skill package contains too much data (possible zip bomb)')
      }
    }
    const skillMdEntry = zipEntries.find(entry => entry.entryName.endsWith('SKILL.md') && !entry.isDirectory)
    if (!skillMdEntry) throw new Error('Invalid skill package: SKILL.md not found')
    if (skillMdEntry.header.size > MAX_FILE_SIZE) {
      throw new Error(`SKILL.md too large (${Math.round(skillMdEntry.header.size / 1024)}KB). Maximum: ${Math.round(MAX_FILE_SIZE / 1024)}KB`)
    }
    const skillMdContent = skillMdEntry.getData().toString('utf8')
    if (skillMdContent.length > MAX_FILE_SIZE) throw new Error('SKILL.md content too large after conversion')
    const { metadata } = parseFrontmatter(skillMdContent)
    const additionalFiles = zipEntries
      .filter(entry => !entry.isDirectory && !entry.entryName.endsWith('SKILL.md') && !entry.entryName.includes('.claude-plugin/'))
      .map(entry => {
        const fullPath = entry.entryName
        const skillFolder = `${skillName}/`
        const relativePath = fullPath.startsWith(skillFolder) ? fullPath.substring(skillFolder.length) : fullPath
        return { path: relativePath, filename: path.basename(relativePath), content: entry.getData().toString('utf8') }
      })
    if (spinner) spinner.stop()
    return {
      id: postId,
      skillName: skillName,
      description: plugin.description || metadata.description,
      version: metadata.version,
      skillMd: skillMdContent,
      author: plugin.author,
      files: additionalFiles,
      _zipData: zip
    }
  } catch (error) {
    if (!silent) {
      if (spinner) spinner.stop()
      console.log(chalk.red(`✖ ${error.message}`))
      process.exit(1)
    }
    throw error
  }
}

async function promptInstallationType() {
  const answers = await inquirer.prompt([{
    type: 'list',
    name: 'installType',
    message: 'Where would you like to install this skill?',
    choices: [
      { name: 'Personal Skills (available globally in all projects)', value: 'personal', short: 'Personal' },
      { name: 'Project Skills (available only in this project)', value: 'project', short: 'Project' }
    ]
  }])
  return answers.installType
}

function getInstallDirectory(installType, skillName) {
  return installType === 'personal'
    ? path.join(os.homedir(), '.claude', 'skills', skillName)
    : path.join(process.cwd(), '.claude', 'skills', skillName)
}

function getSkillDirectories(skillName) {
  const personalDir = path.join(os.homedir(), '.claude', 'skills', skillName)
  const projectDir = path.join(process.cwd(), '.claude', 'skills', skillName)
  const isDuplicate = path.resolve(personalDir) === path.resolve(projectDir)
  return { personalDir, projectDir, isDuplicate }
}

async function installSkill(skill, installType, options = {}) {
  const installDir = getInstallDirectory(installType, skill.skillName)
  const silent = options.silent || false
  const spinner = silent ? null : ora('Installing skill...').start()
  try {
    validateSkillDirectory(installDir, skill.skillName)
    if (fs.existsSync(installDir)) {
      if (spinner) spinner.text = 'Removing existing skill...'
      safeRemoveDirectory(installDir, skill.skillName)
    }
    if (spinner) spinner.text = 'Installing skill...'
    const baseDir = installType === 'personal'
      ? path.join(os.homedir(), '.claude', 'skills')
      : path.join(process.cwd(), '.claude', 'skills')
    safeCreateDirectory(installDir, baseDir)
    const skillMdPath = path.join(installDir, 'SKILL.md')
    safeWriteFile(skillMdPath, skill.skillMd || '', installDir)
    if (skill.files && skill.files.length > 0) {
      for (const file of skill.files) {
        try {
          const normalizedPath = normalizeUntrustedPath(file.path)
          const filePath = path.join(installDir, normalizedPath)
          safeWriteFile(filePath, file.content || '', installDir)
        } catch (error) {
          console.warn(chalk.yellow(`⚠ Skipping file: ${file.path} - ${error.message}`))
          continue
        }
      }
    }
    if (silent) {
      console.log(chalk.green('  ✓') + chalk.cyan(` /${skill.skillName}`) + chalk.dim(' installed'))
    } else {
      spinner.succeed(chalk.green('Installed successfully!'))
      console.log(chalk.dim('  Location: ') + chalk.cyan(installDir))
      const scope = installType === 'personal' ? 'available globally' : 'available in this project'
      console.log(chalk.dim('  Scope: ') + chalk.white(scope))
      console.log(chalk.bold('Usage: ') + chalk.cyan(`/${skill.skillName}`))
    }
  } catch (error) {
    if (silent) {
      console.log(chalk.red('  ✗') + chalk.cyan(` /${skill.skillName}`) + chalk.dim(' failed'))
      throw error
    } else {
      spinner.fail(chalk.red('Failed to install skill'))
      console.error(chalk.red('\nError:'), error.message)
      process.exit(1)
    }
  }
}

async function installSkillCommand(skillName) {
  skillName = validateSkillNameOrExit(skillName)
  const skill = await fetchSkill(skillName)
  displaySkillInfo(skill)
  const installType = await promptInstallationType()
  await installSkill(skill, installType)
}

async function installCollectionCommand(collectionId) {
  if (!collectionId || typeof collectionId !== 'string') {
    console.log(chalk.red('✗ Invalid collection ID'))
    process.exit(1)
  }
  const trimmedId = collectionId.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId) || trimmedId.length > 100) {
    console.log(chalk.red('✗ Invalid collection ID format'))
    console.log(chalk.dim('Collection ID must contain only letters, numbers, hyphens, and underscores'))
    process.exit(1)
  }
  const spinner = ora('Fetching collection...').start()
  try {
    const response = await axios.get(`${API_BASE_URL}/api/collections/${trimmedId}`, {
      headers: { 'User-Agent': `skillscokac-cli/${VERSION}` },
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300
    })
    const collection = response.data
    spinner.stop()
    console.log(chalk.bold.cyan('Collection:'), collection.name)
    if (collection.description) console.log(chalk.dim(collection.description))
    console.log()
    const skills = collection.saves.map(save => save.post).filter(post => {
      if (!post || post.type !== 'SKILL' || !post.skillName || post.isDeleted) return false
      try {
        validateSkillName(post.skillName)
        return true
      } catch (error) {
        return false
      }
    })
    if (skills.length === 0) {
      console.log(chalk.yellow('No skills found in this collection'))
      console.log()
      return
    }
    console.log(chalk.bold(`Found ${skills.length} skill${skills.length !== 1 ? 's' : ''}:`))
    skills.forEach((skill, index) => {
      console.log(chalk.dim(`  ${index + 1}. `) + chalk.cyan(`/${skill.skillName}`) + (skill.description ? chalk.dim(` - ${skill.description}`) : ''))
    })
    console.log()
    const confirmation = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmInstall',
      message: `Install all ${skills.length} skill${skills.length !== 1 ? 's' : ''}?`,
      default: true
    }])
    if (!confirmation.confirmInstall) {
      console.log(chalk.yellow('Installation cancelled'))
      console.log()
      return
    }
    const installType = await promptInstallationType()
    console.log()
    console.log(chalk.bold('Installing skills...'))
    console.log()
    let successCount = 0, failCount = 0
    for (let i = 0; i < skills.length; i++) {
      const skillPost = skills[i]
      if (!skillPost || typeof skillPost !== 'object') {
        console.log(chalk.red('  ✗') + chalk.dim(' Invalid skill data'))
        failCount++
        continue
      }
      const skillName = skillPost.skillName
      try {
        validateSkillName(skillName)
      } catch (error) {
        console.log(chalk.red('  ✗') + chalk.dim(` Invalid skill name: ${error.message}`))
        failCount++
        continue
      }
      try {
        const skill = await fetchSkill(skillName, { silent: true })
        await installSkill(skill, installType, { silent: true })
        successCount++
      } catch (error) {
        console.log(chalk.red('  ✗') + chalk.cyan(` /${skillName}`) + chalk.dim(' failed') + chalk.red(` - ${error.message}`))
        failCount++
      }
    }
    console.log()
    console.log(chalk.bold('Installation Summary:'))
    console.log(chalk.green(`  ✓ Successfully installed: ${successCount}`))
    if (failCount > 0) console.log(chalk.red(`  ✗ Failed: ${failCount}`))
    console.log()
  } catch (error) {
    if (error.response && error.response.status === 404) {
      spinner.fail(chalk.red('Collection not found'))
    } else if (error.response && error.response.status === 403) {
      spinner.fail(chalk.red('Collection is private'))
    } else {
      spinner.fail(chalk.red('Failed to fetch collection'))
    }
    process.exit(1)
  }
}

function getSkillsFromDirectory(skillsDir) {
  if (!fs.existsSync(skillsDir)) return []
  const skills = []
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(skillsDir, entry.name)
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue
    try {
      const validatedName = validateSkillName(entry.name)
      const skillMdContent = fs.readFileSync(skillMdPath, 'utf8')
      const { metadata } = parseFrontmatter(skillMdContent)
      skills.push({
        name: validatedName,
        displayName: metadata.name || validatedName,
        description: metadata.description || 'No description',
        version: metadata.version,
        path: skillDir
      })
    } catch (error) {
      continue
    }
  }
  return skills
}

async function removeSkillCommand(skillName, force = false) {
  skillName = validateSkillNameOrExit(skillName)
  const { personalDir, projectDir, isDuplicate } = getSkillDirectories(skillName)
  if (fs.existsSync(personalDir)) validateSkillDirectory(personalDir, skillName)
  if (!isDuplicate && fs.existsSync(projectDir)) validateSkillDirectory(projectDir, skillName)
  const personalExists = fs.existsSync(personalDir)
  const projectExists = !isDuplicate && fs.existsSync(projectDir)
  if (!personalExists && !projectExists) {
    console.log(chalk.red(`✗ Skill "${skillName}" is not installed`))
    process.exit(1)
  }
  let dirsToRemove = []
  if (force) {
    if (personalExists) dirsToRemove.push({ dir: personalDir, type: 'personal' })
    if (projectExists) dirsToRemove.push({ dir: projectDir, type: 'project' })
  } else {
    if (personalExists && projectExists) {
      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'removeFrom',
        message: `Skill "${skillName}" is installed in both locations. Where do you want to remove it from?`,
        choices: [
          { name: 'Personal Skills (global)', value: 'personal', short: 'Personal' },
          { name: 'Project Skills (local)', value: 'project', short: 'Project' },
          { name: 'Both locations', value: 'both', short: 'Both' }
        ]
      }])
      if (answer.removeFrom === 'personal') {
        dirsToRemove = [{ dir: personalDir, type: 'personal' }]
      } else if (answer.removeFrom === 'project') {
        dirsToRemove = [{ dir: projectDir, type: 'project' }]
      } else {
        dirsToRemove = [{ dir: personalDir, type: 'personal' }, { dir: projectDir, type: 'project' }]
      }
    } else if (personalExists) {
      dirsToRemove = [{ dir: personalDir, type: 'personal' }]
    } else {
      dirsToRemove = [{ dir: projectDir, type: 'project' }]
    }
    const confirmation = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmDelete',
      message: `Are you sure you want to remove "${skillName}"?`,
      default: false
    }])
    if (!confirmation.confirmDelete) {
      console.log(chalk.yellow('Removal cancelled'))
      console.log()
      return
    }
  }
  const spinner = ora('Removing skill...').start()
  try {
    for (const { dir, type } of dirsToRemove) {
      safeRemoveDirectory(dir, skillName)
    }
    spinner.succeed(chalk.green('Skill removed successfully!'))
    console.log()
    dirsToRemove.forEach(({ type }) => {
      const location = type === 'personal' ? 'Personal Skills' : 'Project Skills'
      console.log(chalk.dim(`  ✓ Removed from ${location}`))
    })
    console.log()
  } catch (error) {
    spinner.fail(chalk.red('Failed to remove skill'))
    console.error(chalk.red('\nError:'), error.message)
    process.exit(1)
  }
}

async function removeAllSkillsCommand(force = false) {
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills')
  const isDuplicate = path.resolve(personalSkillsDir) === path.resolve(projectSkillsDir)
  if (fs.existsSync(personalSkillsDir)) validateSkillDirectory(personalSkillsDir, null)
  if (!isDuplicate && fs.existsSync(projectSkillsDir)) validateSkillDirectory(projectSkillsDir, null)
  const personalSkills = getSkillsFromDirectory(personalSkillsDir)
  const projectSkills = isDuplicate ? [] : getSkillsFromDirectory(projectSkillsDir)
  const totalSkills = personalSkills.length + projectSkills.length
  if (totalSkills === 0) {
    console.log(chalk.yellow('No skills installed'))
    console.log()
    return
  }
  if (!force) {
    console.log(chalk.bold('Skills to be removed:'))
    console.log()
    if (personalSkills.length > 0) {
      console.log(chalk.green('Personal Skills:'))
      personalSkills.forEach(skill => console.log(chalk.dim(`  - /${skill.name}`)))
      console.log()
    }
    if (projectSkills.length > 0) {
      console.log(chalk.yellow('Project Skills:'))
      projectSkills.forEach(skill => console.log(chalk.dim(`  - /${skill.name}`)))
      console.log()
    }
    console.log(chalk.bold.red(`Total: ${totalSkills} skill${totalSkills !== 1 ? 's' : ''} will be deleted`))
    console.log()
    const confirmation = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmDelete',
      message: chalk.red('Are you absolutely sure you want to remove ALL skills?'),
      default: false
    }])
    if (!confirmation.confirmDelete) {
      console.log(chalk.yellow('Removal cancelled'))
      console.log()
      return
    }
  }
  const spinner = ora('Removing all skills...').start()
  try {
    let removedCount = 0
    if (personalSkills.length > 0 && fs.existsSync(personalSkillsDir)) {
      for (const skill of personalSkills) {
        const skillDir = path.join(personalSkillsDir, skill.name)
        if (fs.existsSync(skillDir)) {
          validateSkillDirectory(skillDir, skill.name)
          safeRemoveDirectory(skillDir, skill.name)
          removedCount++
        }
      }
    }
    if (!isDuplicate && projectSkills.length > 0 && fs.existsSync(projectSkillsDir)) {
      for (const skill of projectSkills) {
        const skillDir = path.join(projectSkillsDir, skill.name)
        if (fs.existsSync(skillDir)) {
          validateSkillDirectory(skillDir, skill.name)
          safeRemoveDirectory(skillDir, skill.name)
          removedCount++
        }
      }
    }
    spinner.succeed(chalk.green('All skills removed successfully!'))
    console.log()
    console.log(chalk.dim(`  ✓ Removed ${removedCount} skill${removedCount !== 1 ? 's' : ''}`))
    console.log()
  } catch (error) {
    spinner.fail(chalk.red('Failed to remove all skills'))
    console.error(chalk.red('\nError:'), error.message)
    process.exit(1)
  }
}

async function downloadSkillCommand(skillName, downloadPath) {
  skillName = validateSkillNameOrExit(skillName)
  if (!downloadPath) downloadPath = process.cwd()
  const skill = await fetchSkill(skillName)
  displaySkillInfo(skill)
  console.log()
  const resolvedPath = path.resolve(downloadPath)
  const targetDir = path.join(resolvedPath, skill.skillName)
  const spinner = ora('Downloading skill...').start()
  try {
    if (fs.existsSync(targetDir)) {
      spinner.text = 'Removing existing directory...'
      safeRemoveDirectory(targetDir, resolvedPath, false)
    }
    spinner.text = 'Creating directory...'
    safeCreateDirectory(targetDir, resolvedPath, false)
    spinner.text = 'Writing files...'
    const skillMdPath = path.join(targetDir, 'SKILL.md')
    safeWriteFile(skillMdPath, skill.skillMd || '', targetDir, false)
    if (skill.files && skill.files.length > 0) {
      for (const file of skill.files) {
        try {
          const normalizedPath = normalizeUntrustedPath(file.path)
          const filePath = path.join(targetDir, normalizedPath)
          safeWriteFile(filePath, file.content || '', targetDir, false)
        } catch (error) {
          console.warn(chalk.yellow(`⚠ Skipping file: ${file.path} - ${error.message}`))
          continue
        }
      }
    }
    spinner.succeed(chalk.green('Downloaded successfully!'))
    console.log()
    console.log(chalk.dim('  Location: ') + chalk.cyan(targetDir))
    console.log(chalk.dim('  Files: ') + chalk.white(`${1 + (skill.files ? skill.files.length : 0)} file${skill.files && skill.files.length !== 0 ? 's' : ''}`))
    console.log()
  } catch (error) {
    spinner.fail(chalk.red('Failed to download skill'))
    console.error(chalk.red('\nError:'), error.message)
    process.exit(1)
  }
}

function displaySkillBox(skills, borderColor) {
  const skillContents = skills.map(skill => {
    let content = chalk.bold.cyan(`/${skill.name}`)
    if (skill.description) content += '\n' + chalk.white(skill.description)
    if (skill.version) content += '\n' + chalk.dim(`Version: ${skill.version}`)
    return content
  })
  const allContent = skillContents.join('\n\n')
  console.log(boxen(allContent, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 0, bottom: 0, left: 2, right: 0 },
    borderStyle: 'round',
    borderColor: borderColor,
    width: 70
  }))
  console.log()
}

async function listInstalledSkillsCommand() {
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const personalSkills = getSkillsFromDirectory(personalSkillsDir)
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills')
  const isDuplicate = path.resolve(personalSkillsDir) === path.resolve(projectSkillsDir)
  const projectSkills = isDuplicate ? [] : getSkillsFromDirectory(projectSkillsDir)
  console.log(chalk.bold.green('📦 Personal Skills') + chalk.dim(` (global)`))
  console.log(chalk.dim(`   ${personalSkillsDir}`))
  if (personalSkills.length > 0) {
    displaySkillBox(personalSkills, 'cyan')
  } else {
    console.log(chalk.dim('   No personal skills installed'))
    console.log()
  }
  if (!isDuplicate) {
    console.log(chalk.bold.yellow('📁 Project Skills') + chalk.dim(` (current directory)`))
    console.log(chalk.dim(`   ${projectSkillsDir}`))
    if (projectSkills.length > 0) {
      displaySkillBox(projectSkills, 'yellow')
    } else {
      console.log(chalk.dim('   No project skills installed'))
      console.log()
    }
  }
  const total = personalSkills.length + projectSkills.length
  if (total === 0) {
    console.log(chalk.dim('No skills installed yet. Install one with:'))
    console.log(chalk.cyan('  npx skillscokac --install-skill <skill-name>'))
    console.log()
  } else {
    console.log(chalk.dim(`Total: ${total} skill${total !== 1 ? 's' : ''} installed`))
    console.log()
  }
}

async function createSkill(skillData, apiKey, silent = false) {
  const payload = {
    type: 'SKILL',
    title: skillData.name,
    description: skillData.description,
    content: skillData.content,
    skillMd: skillData.content,
    visibility: skillData.visibility || 'PUBLIC',
    tags: skillData.tags || ['claude-code', 'agent-skill']
  }
  try {
    const response = await axios.post(`${API_BASE_URL}/api/posts`, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT
    })
    return response.data
  } catch (error) {
    if (error.response && error.response.status === 409) {
      if (!silent) console.log(chalk.red('✗ Skill name already exists. Please choose a different name.'))
    } else if (!silent) {
      console.log(chalk.red('✗ Failed to create skill'))
      if (error.response) {
        console.error(chalk.red('  Status:'), error.response.status)
        console.error(chalk.red('  Response:'), error.response.data)
      } else {
        console.error(chalk.red('  Error:'), error.message)
      }
    }
    throw error
  }
}

function collectSkillFiles(skillDir, silent = false) {
  const files = []
  function findFiles(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue
        findFiles(fullPath, baseDir)
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath)
        if (relativePath === 'SKILL.md' || entry.name.startsWith('.')) continue
        const stats = fs.statSync(fullPath)
        if (stats.size > MAX_FILE_SIZE) {
          if (!silent) console.warn(chalk.yellow(`⚠ Skipping large file (${Math.round(stats.size / 1024 / 1024)}MB): ${relativePath}`))
          continue
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf8')
          files.push({ path: relativePath.replace(/\\/g, '/'), content: content })
        } catch (err) {
          continue
        }
      }
    }
  }
  findFiles(skillDir, skillDir)
  return files
}

async function uploadSkillFiles(skillId, skillDir, apiKey, silent = false) {
  const files = collectSkillFiles(skillDir, silent)
  if (files.length === 0) return { uploadedCount: 0, failedCount: 0 }
  let uploadedCount = 0, failedCount = 0
  for (const file of files) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api/posts/${skillId}/files`, file, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': `skillscokac-cli/${VERSION}`
        },
        timeout: AXIOS_TIMEOUT
      })
      if (response.status === 201) uploadedCount++; else failedCount++
    } catch (error) {
      failedCount++
    }
  }
  return { uploadedCount, failedCount }
}

async function uploadSkillCommand(skillDir, apiKey) {
  if (!apiKey) {
    console.log(chalk.red('✗ API key is required'))
    console.log(chalk.dim('Usage: npx skillscokac --upload <skillDir> --apikey <key>'))
    console.log()
    process.exit(1)
  }
  const resolvedSkillDir = path.resolve(skillDir)
  const skillMdPath = path.join(resolvedSkillDir, 'SKILL.md')
  if (!fs.existsSync(resolvedSkillDir)) {
    console.log(chalk.red(`✗ Directory not found: ${resolvedSkillDir}`))
    console.log()
    process.exit(1)
  }
  if (!fs.existsSync(skillMdPath)) {
    console.log(chalk.red(`✗ SKILL.md not found in: ${resolvedSkillDir}`))
    console.log(chalk.dim('  The skill directory must contain a SKILL.md file'))
    console.log()
    process.exit(1)
  }
  let spinner
  try {
    spinner = ora('Uploading skill...').start()
    const skillMdContent = fs.readFileSync(skillMdPath, 'utf8')
    const { metadata } = parseFrontmatter(skillMdContent)
    if (!metadata.name) {
      spinner.fail(chalk.red('SKILL.md must have a "name" in frontmatter'))
      process.exit(1)
    }
    if (!metadata.description) {
      spinner.fail(chalk.red('SKILL.md must have a "description" in frontmatter'))
      process.exit(1)
    }
    const validatedSkillName = validateSkillName(metadata.name)
    const skillData = {
      name: validatedSkillName,
      description: metadata.description,
      content: skillMdContent,
      visibility: 'PUBLIC',
      tags: ['claude-code', 'agent-skill']
    }
    spinner.text = 'Creating skill...'
    const skill = await createSkill(skillData, apiKey, true)
    spinner.text = 'Uploading files...'
    const { uploadedCount, failedCount } = await uploadSkillFiles(skill.id, resolvedSkillDir, apiKey, true)
    const fileInfo = uploadedCount > 0 ? ` (${uploadedCount} file${uploadedCount !== 1 ? 's' : ''})` : ''
    spinner.succeed(chalk.green(`Uploaded: ${skillData.name}${fileInfo}`))
    console.log(chalk.cyan(`https://skills.cokac.com/p/${skill.id}`))
  } catch (error) {
    if (spinner) spinner.stop()
    if (error.response && error.response.status === 409) {
      console.log(chalk.red('✗ Skill name already exists. Please choose a different name.'))
    } else {
      console.error(chalk.red('✗ Upload failed:'), error.message)
    }
    process.exit(1)
  }
}

async function findSkillByName(skillName, apiKey) {
  skillName = validateSkillName(skillName)
  try {
    const response = await axios.get(`${API_BASE_URL}/api/skills/${skillName}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': `skillscokac-cli/${VERSION}` },
      timeout: AXIOS_TIMEOUT
    })
    return response.data
  } catch (error) {
    if (error.response && error.response.status === 404) return null
    throw error
  }
}

async function updateSkillIndividually(postId, skillMdContent, skillDir, apiKey, silent = false) {
  const files = collectSkillFiles(skillDir, silent)
  await axios.patch(`${API_BASE_URL}/api/posts/${postId}`, { skillMd: skillMdContent }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': `skillscokac-cli/${VERSION}` },
    timeout: AXIOS_TIMEOUT
  })
  const existingSkill = await axios.get(`${API_BASE_URL}/api/posts/${postId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': `skillscokac-cli/${VERSION}` },
    timeout: AXIOS_TIMEOUT
  })
  const existingFiles = existingSkill.data.skillFiles || []
  for (const file of existingFiles) {
    try {
      await axios.delete(`${API_BASE_URL}/api/posts/${postId}/files/${file.id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': `skillscokac-cli/${VERSION}` },
        timeout: AXIOS_TIMEOUT
      })
    } catch (err) {
      if (!silent) console.warn(chalk.yellow(`⚠ Failed to delete file: ${file.path}`))
    }
  }
  let uploadedCount = 0
  for (const file of files) {
    try {
      await axios.post(`${API_BASE_URL}/api/posts/${postId}/files`, file, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': `skillscokac-cli/${VERSION}` },
        timeout: AXIOS_TIMEOUT
      })
      uploadedCount++
    } catch (err) {
      if (!silent) console.warn(chalk.yellow(`⚠ Failed to upload file: ${file.path}`))
    }
  }
  return { uploadedCount: uploadedCount, deletedCount: existingFiles.length }
}

async function updateSkillWithBatch(postId, skillMdContent, skillDir, apiKey, silent = false) {
  const files = collectSkillFiles(skillDir, silent)
  const existingSkill = await axios.get(`${API_BASE_URL}/api/posts/${postId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': `skillscokac-cli/${VERSION}` },
    timeout: AXIOS_TIMEOUT
  })
  const existingFiles = existingSkill.data.skillFiles || []
  const batchPayload = { skillMd: skillMdContent, files: { delete: existingFiles.map(f => ({ id: f.id })), create: files } }
  const response = await axios.post(`${API_BASE_URL}/api/posts/${postId}/files/batch`, batchPayload, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': `skillscokac-cli/${VERSION}` },
    timeout: AXIOS_TIMEOUT
  })
  return { uploadedCount: files.length, deletedCount: existingFiles.length }
}

async function uploadModifySkillCommand(skillDir, apiKey) {
  if (!apiKey) {
    console.log(chalk.red('✗ API key is required'))
    console.log(chalk.dim('Usage: npx skillscokac --uploadmodify <skillDir> --apikey <key>'))
    console.log()
    process.exit(1)
  }
  const resolvedSkillDir = path.resolve(skillDir)
  const skillMdPath = path.join(resolvedSkillDir, 'SKILL.md')
  if (!fs.existsSync(resolvedSkillDir)) {
    console.log(chalk.red(`✗ Directory not found: ${resolvedSkillDir}`))
    console.log()
    process.exit(1)
  }
  if (!fs.existsSync(skillMdPath)) {
    console.log(chalk.red(`✗ SKILL.md not found in: ${resolvedSkillDir}`))
    console.log(chalk.dim('  The skill directory must contain a SKILL.md file'))
    console.log()
    process.exit(1)
  }
  let spinner
  try {
    spinner = ora('Checking skill...').start()
    const skillMdContent = fs.readFileSync(skillMdPath, 'utf8')
    const { metadata } = parseFrontmatter(skillMdContent)
    if (!metadata.name) {
      spinner.fail(chalk.red('SKILL.md must have a "name" in frontmatter'))
      process.exit(1)
    }
    if (!metadata.description) {
      spinner.fail(chalk.red('SKILL.md must have a "description" in frontmatter'))
      process.exit(1)
    }
    const skillName = validateSkillName(metadata.name)
    spinner.text = 'Checking if skill exists...'
    const existingSkill = await findSkillByName(skillName, apiKey)
    if (existingSkill) {
      console.log(chalk.yellow(`Skill "${skillName}" already exists. Updating...`))
      spinner.text = 'Updating skill and files...'
      const { uploadedCount, deletedCount } = await updateSkillIndividually(existingSkill.id, skillMdContent, resolvedSkillDir, apiKey, true)
      spinner.succeed(chalk.green(`Updated: ${skillName} (${uploadedCount} files)`))
      console.log(chalk.dim(`  Deleted ${deletedCount} old file${deletedCount !== 1 ? 's' : ''}, uploaded ${uploadedCount} new file${uploadedCount !== 1 ? 's' : ''}`))
      console.log(chalk.cyan(`https://skills.cokac.com/p/${existingSkill.id}`))
    } else {
      console.log(chalk.cyan(`Skill "${skillName}" does not exist. Creating new...`))
      const skillData = {
        name: skillName,
        description: metadata.description,
        content: skillMdContent,
        visibility: 'PUBLIC',
        tags: ['claude-code', 'agent-skill']
      }
      spinner.text = 'Creating skill...'
      const skill = await createSkill(skillData, apiKey, true)
      spinner.text = 'Uploading files...'
      const { uploadedCount } = await uploadSkillFiles(skill.id, resolvedSkillDir, apiKey, true)
      const fileInfo = uploadedCount > 0 ? ` (${uploadedCount} file${uploadedCount !== 1 ? 's' : ''})` : ''
      spinner.succeed(chalk.green(`Created: ${skillData.name}${fileInfo}`))
      console.log(chalk.cyan(`https://skills.cokac.com/p/${skill.id}`))
    }
  } catch (error) {
    if (spinner) spinner.stop()
    if (error.response) {
      if (error.response.status === 403) {
        console.log(chalk.red('✗ Forbidden: You do not have permission to modify this skill'))
      } else if (error.response.status === 401) {
        console.log(chalk.red('✗ Unauthorized: Invalid API key'))
      } else {
        console.error(chalk.red('✗ Upload/Update failed:'), error.response.data?.error || error.message)
      }
    } else {
      console.error(chalk.red('✗ Upload/Update failed:'), error.message)
    }
    process.exit(1)
  }
}

const program = new Command()
program
  .name('skillscokac')
  .description('CLI tool to install Claude Code skills from skills.cokac.com')
  .version(VERSION)
program
  .option('-i, --install-skill <skillName>', 'Install a skill by name')
  .option('-c, --install-collection <collectionId>', 'Install all skills from a collection')
  .option('-d, --download <args...>', 'Download a skill to a directory (usage: --download <skillName> [path], defaults to current directory)')
  .option('-u, --upload <skillDir>', 'Upload a skill from a directory (requires --apikey)')
  .option('-m, --uploadmodify <skillDir>', 'Upload or update a skill (creates if new, updates if exists, requires --apikey)')
  .option('--apikey <key>', 'API key for uploading skills')
  .option('-r, --remove-skill <skillName>', 'Remove an installed skill')
  .option('-f, --remove-skill-force <skillName>', 'Remove skill from all locations without confirmation')
  .option('-a, --remove-all-skills', 'Remove all installed skills')
  .option('-A, --remove-all-skills-force', 'Remove all installed skills without confirmation')
  .option('-t, --test', 'Test code')
  .option('-l, --list-installed-skills', 'List all installed skills')
  .parse(process.argv)

const options = program.opts()

  ; (async () => {
    try {
      if (options.installSkill) {
        await installSkillCommand(options.installSkill)
      } else if (options.installCollection) {
        await installCollectionCommand(options.installCollection)
      } else if (options.download) {
        if (options.download.length < 1 || options.download.length > 2) {
          console.log(chalk.red('✗ Invalid arguments for --download'))
          console.log(chalk.dim('Usage: npx skillscokac --download <skillName> [path]'))
          console.log()
          process.exit(1)
        }
        const [skillName, downloadPath] = options.download
        await downloadSkillCommand(skillName, downloadPath)
      } else if (options.test) {
        console.log(validatePathWithinBase('/home/ubuntu/codejogak/skillscokac/11/11', '/home/ubuntu/codejogak/skillscokac/11/', false));
        console.log(validatePathWithinBase('/home/ubuntu/codejogak/skillscokac', '/home/ubuntu/codejogak/skillscokac/ffe'));
        console.log(validatePathWithinBase('/home/ubuntu/codejogak/skillscokac', '/home/ubuntu/codejogak/skillscokac'));
        console.log(validatePathWithinBase('/home/ubuntu/codejogak/skillscokac/dfe', '/home/ubuntu/codejogak/skillscokac'));
        console.log(validatePathWithinBase('/home/ubuntu/.claude', '/home/ubuntu/.claude'));
        console.log(validatePathWithinBase('/home/ubuntu/.claude/dd', '/home/ubuntu/.claude'));
        console.log(validatePathWithinBase('/home/ubuntu/.claude/dd', '/home/ubuntu/.claude/skills'));
        console.log(validatePathWithinBase('/home/ubuntu/.claude/skills', '/home/ubuntu/.claude/skills/'));
        console.log(validatePathWithinBase('/home/ubuntu/.claude/skills/f', '/home/ubuntu/.claude/skills'));
        console.log(isWithInClaudeSkill('/home/ubuntu/.claude/skills/f'));
        console.log(isWithInClaudeSkill('/home/ubuntu/1.claude/skills/f'));
        console.log(isWithInClaudeSkill('/home/ubuntu/.claude/skills'));
      } else if (options.upload) {
        await uploadSkillCommand(options.upload, options.apikey)
      } else if (options.uploadmodify) {
        await uploadModifySkillCommand(options.uploadmodify, options.apikey)
      } else if (options.removeAllSkillsForce) {
        await removeAllSkillsCommand(true)
      } else if (options.removeAllSkills) {
        await removeAllSkillsCommand()
      } else if (options.removeSkillForce) {
        await removeSkillCommand(options.removeSkillForce, true)
      } else if (options.removeSkill) {
        await removeSkillCommand(options.removeSkill)
      } else if (options.listInstalledSkills) {
        await listInstalledSkillsCommand()
      } else {
        program.help()
      }
    } catch (error) {
      console.error(chalk.red('\n✗ Unexpected error:'), error.message)
      if (process.env.DEBUG) console.error(error.stack)
      process.exit(1)
    }
  })()
