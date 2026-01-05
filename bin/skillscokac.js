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

// Load package.json for version
const packageJson = require(path.join(__dirname, '..', 'package.json'))
const VERSION = packageJson.version

const API_BASE_URL = 'https://skills.cokac.com'

// Configuration constants
const MAX_ZIP_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const AXIOS_TIMEOUT = 30000 // 30 seconds

/**
 * Validate skill name for security
 */
function validateSkillName(skillName) {
  if (!skillName || typeof skillName !== 'string') {
    throw new Error('Invalid skill name')
  }

  const trimmed = skillName.trim()

  if (trimmed.length === 0) {
    throw new Error('Skill name cannot be empty')
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Skill name cannot contain path separators')
  }

  if (trimmed.includes('..')) {
    throw new Error('Skill name cannot contain ".."')
  }

  if (trimmed.startsWith('.')) {
    throw new Error('Skill name cannot start with a dot')
  }

  // Check for other potentially dangerous characters
  if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) {
    throw new Error('Skill name contains invalid characters')
  }

  return trimmed
}

/**
 * Preprocess frontmatter to fix common YAML issues
 * Automatically quotes values that contain special characters
 */
function preprocessFrontmatter(frontmatterText) {
  const lines = frontmatterText.split('\n')

  // Limit line count to prevent DoS
  if (lines.length > 1000) {
    throw new Error('Frontmatter too complex (max 1000 lines)')
  }

  const processedLines = []

  for (const line of lines) {
    // Limit line length to prevent ReDoS
    if (line.length > 2000) {
      throw new Error('Frontmatter line too long (max 2000 characters)')
    }

    // Skip empty lines or comments
    if (!line.trim() || line.trim().startsWith('#')) {
      processedLines.push(line)
      continue
    }

    // Match key-value pairs with non-greedy match to prevent ReDoS
    // Key must start with letter, value limited to prevent backtracking
    const match = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_-]*):\s*([^\n\r]{0,1500})$/)

    if (!match || match.length !== 4) {
      // Not a simple key-value pair, keep as is
      processedLines.push(line)
      continue
    }

    const indent = match[1]
    const key = match[2]
    const value = match[3]

    // Skip if value is empty
    if (!value.trim()) {
      processedLines.push(line)
      continue
    }

    // Skip if already quoted (starts and ends with quotes)
    const trimmedValue = value.trim()
    if ((trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
        (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))) {
      processedLines.push(line)
      continue
    }

    // Skip if it's a block scalar (| or >)
    if (trimmedValue === '|' || trimmedValue === '>') {
      processedLines.push(line)
      continue
    }

    // Skip if it's an array or object
    if (trimmedValue.startsWith('[') || trimmedValue.startsWith('{')) {
      processedLines.push(line)
      continue
    }

    // Check if value contains special YAML characters that need quoting
    const needsQuoting = /[:{}[\]|>@`&*!%#]/.test(value)

    if (needsQuoting) {
      // Proper escaping for YAML double-quoted strings
      let escapedValue = value
        .replace(/\\/g, '\\\\')  // Escape backslashes first
        .replace(/"/g, '\\"')     // Escape double quotes
        .replace(/\n/g, '\\n')    // Escape newlines
        .replace(/\r/g, '\\r')    // Escape carriage returns
        .replace(/\t/g, '\\t')    // Escape tabs

      processedLines.push(`${indent}${key}: "${escapedValue}"`)
    } else {
      processedLines.push(line)
    }
  }

  return processedLines.join('\n')
}

/**
 * Parse frontmatter from markdown content
 * Handles both Unix (\n) and Windows (\r\n) line endings
 */
function parseFrontmatter(content) {
  // Normalize line endings to handle both CRLF and LF
  const normalizedContent = content.replace(/\r\n/g, '\n')
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/
  const match = normalizedContent.match(frontmatterRegex)

  if (!match) {
    return { metadata: {}, content: normalizedContent }
  }

  try {
    // Limit frontmatter size to prevent YAML bombs
    if (match[1].length > 10000) {
      throw new Error('Frontmatter too large (max 10KB)')
    }

    // Preprocess frontmatter to fix common YAML issues
    const preprocessed = preprocessFrontmatter(match[1])

    // Parse with strict options to prevent YAML bombs
    const metadata = yaml.parse(preprocessed, {
      maxAliasCount: 10,      // Limit alias expansion to prevent Billion Laughs
      strict: true,           // Strict YAML parsing
      uniqueKeys: true,       // Reject duplicate keys
      version: '1.2'          // Use YAML 1.2 spec
    })

    // Validate metadata is a plain object
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

/**
 * Display skill information
 */
function displaySkillInfo(skill) {
  const { metadata } = parseFrontmatter(skill.skillMd || '')

  // Skill name
  const displayName = metadata.name || skill.skillName
  console.log(chalk.bold.cyan(`/${skill.skillName}`) + (displayName !== skill.skillName ? chalk.dim(` (${displayName})`) : ''))

  // Description
  if (metadata.description) {
    console.log(chalk.dim(metadata.description))
  }

  // Metadata in compact format
  const metaItems = []

  if (skill.author) {
    metaItems.push(chalk.dim('Author: ') + chalk.white(skill.author.name || skill.author.username))
  }

  const totalFiles = 1 + (skill.files ? skill.files.length : 0)
  metaItems.push(chalk.dim('Files: ') + chalk.white(`${totalFiles} file${totalFiles !== 1 ? 's' : ''}`))

  if (skill.version) {
    metaItems.push(chalk.dim('Version: ') + chalk.white(skill.version))
  }

  console.log('  ' + metaItems.join(chalk.dim(' • ')))
}

/**
 * Fetch skill from Marketplace and download ZIP
 */
async function fetchSkill(skillName, options = {}) {
  const silent = options.silent || false
  const spinner = silent ? null : ora(`Searching for skill: ${skillName}`).start()

  try {
    // Validate skill name
    skillName = validateSkillName(skillName)

    // Step 1: Get marketplace data to find postId
    if (spinner) spinner.text = 'Fetching marketplace data...'
    const marketplaceResponse = await axios.get(`${API_BASE_URL}/api/marketplace`, {
      headers: {
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 5,  // Limit redirects
      validateStatus: (status) => status === 200  // Only accept 200 OK
    })

    // Validate content type
    const contentType = marketplaceResponse.headers['content-type']
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Invalid response type from server (expected JSON)')
    }

    const marketplace = marketplaceResponse.data

    // Validate marketplace data structure
    if (!marketplace || typeof marketplace !== 'object') {
      throw new Error('Invalid marketplace data received')
    }

    if (!Array.isArray(marketplace.plugins)) {
      throw new Error('Invalid marketplace data: plugins not found')
    }

    const plugin = marketplace.plugins.find(p => p && p.name === skillName)

    if (!plugin) {
      throw new Error(`Skill "${skillName}" not found`)
    }

    // Validate plugin structure
    if (!plugin.source || !plugin.source.url) {
      throw new Error('Invalid skill data: missing source URL')
    }

    // Extract postId from plugin URL
    const postIdMatch = plugin.source.url.match(/\/plugins\/([^/.]+)/)
    if (!postIdMatch) {
      throw new Error('Failed to parse skill URL')
    }

    const postId = postIdMatch[1]

    // Step 2: Download ZIP file
    if (spinner) spinner.text = 'Downloading skill files...'
    const zipResponse = await axios.get(
      `${API_BASE_URL}/api/posts/${postId}/export-skill-zip`,
      {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': `skillscokac-cli/${VERSION}`
        },
        timeout: AXIOS_TIMEOUT,
        maxContentLength: MAX_ZIP_SIZE
      }
    )

    // Check ZIP file size
    const zipSize = zipResponse.data.byteLength
    if (zipSize > MAX_ZIP_SIZE) {
      throw new Error(`Skill package too large (${Math.round(zipSize / 1024 / 1024)}MB). Maximum: ${Math.round(MAX_ZIP_SIZE / 1024 / 1024)}MB`)
    }

    // Step 3: Extract ZIP
    if (spinner) spinner.text = 'Extracting files...'
    const zip = new AdmZip(Buffer.from(zipResponse.data))
    const zipEntries = zip.getEntries()

    // Check total uncompressed size and validate entries
    let totalSize = 0
    const MAX_COMPRESSION_RATIO = 100  // 100:1 max ratio to prevent zip bombs

    for (const entry of zipEntries) {
      const entryName = entry.entryName

      // Validate entry name for security
      // Reject absolute paths
      if (path.isAbsolute(entryName)) {
        throw new Error(`Invalid zip entry: absolute path not allowed: ${entryName}`)
      }

      // Reject path traversal attempts
      const normalized = path.normalize(entryName).replace(/\\/g, '/')
      if (normalized.includes('..') || normalized.startsWith('.')) {
        throw new Error(`Invalid zip entry: path traversal detected: ${entryName}`)
      }

      // Reject entries with null bytes
      if (entryName.includes('\0')) {
        throw new Error('Invalid zip entry: null byte in filename')
      }

      // Validate file entries
      if (!entry.isDirectory) {
        const uncompressedSize = entry.header.size
        const compressedSize = entry.header.compressedSize

        // Check individual file size
        if (uncompressedSize > MAX_FILE_SIZE * 2) {
          throw new Error(`File too large in package: ${entryName} (${Math.round(uncompressedSize / 1024 / 1024)}MB)`)
        }

        // Check compression ratio to detect zip bombs
        if (compressedSize > 0) {
          const ratio = uncompressedSize / compressedSize
          if (ratio > MAX_COMPRESSION_RATIO) {
            throw new Error(`Suspicious compression ratio detected in ${entryName} (possible zip bomb)`)
          }
        }

        // Check total uncompressed size
        totalSize += uncompressedSize
        if (totalSize > MAX_ZIP_SIZE * 2) {
          throw new Error('Skill package contains too much data (possible zip bomb)')
        }
      }
    }

    // Find SKILL.md
    const skillMdEntry = zipEntries.find(entry =>
      entry.entryName.endsWith('SKILL.md') && !entry.isDirectory
    )

    if (!skillMdEntry) {
      throw new Error('Invalid skill package: SKILL.md not found')
    }

    // Validate SKILL.md size before reading
    if (skillMdEntry.header.size > MAX_FILE_SIZE) {
      throw new Error(`SKILL.md too large (${Math.round(skillMdEntry.header.size / 1024)}KB). Maximum: ${Math.round(MAX_FILE_SIZE / 1024)}KB`)
    }

    const skillMdContent = skillMdEntry.getData().toString('utf8')

    // Validate content length after conversion
    if (skillMdContent.length > MAX_FILE_SIZE) {
      throw new Error('SKILL.md content too large after conversion')
    }

    const { metadata } = parseFrontmatter(skillMdContent)

    // Get additional files (excluding SKILL.md)
    const additionalFiles = zipEntries
      .filter(entry =>
        !entry.isDirectory &&
        !entry.entryName.endsWith('SKILL.md') &&
        !entry.entryName.includes('.claude-plugin/')
      )
      .map(entry => {
        const fullPath = entry.entryName
        const skillFolder = `${skillName}/`
        const relativePath = fullPath.startsWith(skillFolder)
          ? fullPath.substring(skillFolder.length)
          : fullPath

        return {
          path: relativePath,
          filename: path.basename(relativePath),
          content: entry.getData().toString('utf8')
        }
      })

    if (spinner) spinner.stop()

    // Construct skill object
    return {
      id: postId,
      skillName: skillName,
      description: plugin.description || metadata.description,
      version: metadata.version, // Only show if explicitly defined
      skillMd: skillMdContent,
      author: plugin.author,
      files: additionalFiles,
      _zipData: zip // Keep zip for installation
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

/**
 * Prompt for installation type
 */
async function promptInstallationType() {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'installType',
      message: 'Where would you like to install this skill?',
      choices: [
        {
          name: 'Personal Skills (available globally in all projects)',
          value: 'personal',
          short: 'Personal'
        },
        {
          name: 'Project Skills (available only in this project)',
          value: 'project',
          short: 'Project'
        }
      ]
    }
  ])

  return answers.installType
}

/**
 * Get installation directory based on type
 */
function getInstallDirectory(installType, skillName) {
  if (installType === 'personal') {
    return path.join(os.homedir(), '.claude', 'skills', skillName)
  } else {
    return path.join(process.cwd(), '.claude', 'skills', skillName)
  }
}

/**
 * Install skill files
 */
async function installSkill(skill, installType, options = {}) {
  const installDir = getInstallDirectory(installType, skill.skillName)
  const silent = options.silent || false
  const spinner = silent ? null : ora('Installing skill...').start()

  try {
    // Remove existing directory if it exists
    if (fs.existsSync(installDir)) {
      if (spinner) spinner.text = 'Removing existing skill...'
      fs.rmSync(installDir, { recursive: true, force: true })
    }

    // Create fresh directory
    if (spinner) spinner.text = 'Installing skill...'
    fs.mkdirSync(installDir, { recursive: true })

    // Write SKILL.md
    const skillMdPath = path.join(installDir, 'SKILL.md')
    fs.writeFileSync(skillMdPath, skill.skillMd || '', 'utf8')

    // Write additional files
    if (skill.files && skill.files.length > 0) {
      for (const file of skill.files) {
        // Security: Prevent path traversal attacks
        // Normalize the path and remove any leading ../ sequences
        const normalizedPath = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, '')
        const filePath = path.join(installDir, normalizedPath)

        // Verify that the final path is still within installDir
        const resolvedFilePath = path.resolve(filePath)
        const resolvedInstallDir = path.resolve(installDir)

        if (!resolvedFilePath.startsWith(resolvedInstallDir + path.sep) && resolvedFilePath !== resolvedInstallDir) {
          console.warn(chalk.yellow(`⚠ Skipping potentially unsafe file path: ${file.path}`))
          continue
        }

        const fileDir = path.dirname(filePath)

        // Create subdirectories if needed
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true })
        }

        fs.writeFileSync(filePath, file.content || '', 'utf8')
      }
    }

    if (silent) {
      // Compact one-line output for collection installs
      console.log(chalk.green('  ✓') + chalk.cyan(` /${skill.skillName}`) + chalk.dim(' installed'))
    } else {
      // Detailed output for single skill installs
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

/**
 * Install skill command handler
 */
async function installSkillCommand(skillName) {
  // Validate skill name (fetchSkill also validates, but do it early)
  try {
    skillName = validateSkillName(skillName)
  } catch (error) {
    console.log(chalk.red(`✗ ${error.message}`))
    process.exit(1)
  }

  // Fetch skill
  const skill = await fetchSkill(skillName)

  // Display skill info
  displaySkillInfo(skill)

  // Prompt for installation type
  const installType = await promptInstallationType()

  // Install skill
  await installSkill(skill, installType)
}

/**
 * Install collection command handler
 */
async function installCollectionCommand(collectionId) {
  // Validate collection ID to prevent SSRF
  if (!collectionId || typeof collectionId !== 'string') {
    console.log(chalk.red('✗ Invalid collection ID'))
    process.exit(1)
  }

  const trimmedId = collectionId.trim()

  // Collection IDs should be alphanumeric with hyphens/underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId) || trimmedId.length > 100) {
    console.log(chalk.red('✗ Invalid collection ID format'))
    console.log(chalk.dim('Collection ID must contain only letters, numbers, hyphens, and underscores'))
    process.exit(1)
  }

  const spinner = ora('Fetching collection...').start()

  try {
    // Fetch collection (using validated ID)
    const response = await axios.get(`${API_BASE_URL}/api/collections/${trimmedId}`, {
      headers: {
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT,
      maxRedirects: 5,  // Limit redirects
      validateStatus: (status) => status >= 200 && status < 300  // Only accept 2xx
    })

    const collection = response.data
    spinner.stop()

    console.log(chalk.bold.cyan('Collection:'), collection.name)
    if (collection.description) {
      console.log(chalk.dim(collection.description))
    }
    console.log()

    // Filter SKILL type posts
    const skills = collection.saves
      .map(save => save.post)
      .filter(post => post && post.type === 'SKILL' && post.skillName && !post.isDeleted)

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

    // Confirm installation
    const confirmation = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmInstall',
        message: `Install all ${skills.length} skill${skills.length !== 1 ? 's' : ''}?`,
        default: true
      }
    ])

    if (!confirmation.confirmInstall) {
      console.log(chalk.yellow('Installation cancelled'))
      console.log()
      return
    }

    // Prompt for installation type (once for all skills)
    const installType = await promptInstallationType()

    console.log()
    console.log(chalk.bold('Installing skills...'))
    console.log()

    let successCount = 0
    let failCount = 0

    // Install each skill
    for (let i = 0; i < skills.length; i++) {
      const skillPost = skills[i]

      // Validate skillPost structure
      if (!skillPost || typeof skillPost !== 'object') {
        console.log(chalk.red('  ✗') + chalk.dim(' Invalid skill data'))
        failCount++
        continue
      }

      const skillName = skillPost.skillName

      // Validate skill name before processing
      if (!skillName || typeof skillName !== 'string' || skillName.length > 100) {
        console.log(chalk.red('  ✗') + chalk.dim(' Invalid skill name in collection'))
        failCount++
        continue
      }

      try {
        // Fetch and install skill in silent mode
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
    if (failCount > 0) {
      console.log(chalk.red(`  ✗ Failed: ${failCount}`))
    }
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

/**
 * Get skills from a directory
 */
function getSkillsFromDirectory(skillsDir) {
  if (!fs.existsSync(skillsDir)) {
    return []
  }

  const skills = []
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillDir = path.join(skillsDir, entry.name)
    const skillMdPath = path.join(skillDir, 'SKILL.md')

    if (!fs.existsSync(skillMdPath)) continue

    try {
      const skillMdContent = fs.readFileSync(skillMdPath, 'utf8')
      const { metadata } = parseFrontmatter(skillMdContent)

      skills.push({
        name: entry.name,
        displayName: metadata.name || entry.name,
        description: metadata.description || 'No description',
        version: metadata.version,
        path: skillDir
      })
    } catch (error) {
      // Skip if error reading or parsing
      continue
    }
  }

  return skills
}

/**
 * Remove skill command handler
 */
async function removeSkillCommand(skillName, force = false) {
  // Validate skill name
  try {
    skillName = validateSkillName(skillName)
  } catch (error) {
    console.log(chalk.red(`✗ ${error.message}`))
    process.exit(1)
  }

  // Check if skill exists in personal and/or project directories
  const personalSkillDir = path.join(os.homedir(), '.claude', 'skills', skillName)
  const projectSkillDir = path.join(process.cwd(), '.claude', 'skills', skillName)

  const personalExists = fs.existsSync(personalSkillDir)
  const projectExists = fs.existsSync(projectSkillDir)

  if (!personalExists && !projectExists) {
    console.log(chalk.red(`✗ Skill "${skillName}" is not installed`))
    process.exit(1)
  }

  let dirsToRemove = []

  if (force) {
    // Force mode: remove from both locations without asking
    if (personalExists) {
      dirsToRemove.push({ dir: personalSkillDir, type: 'personal' })
    }
    if (projectExists) {
      dirsToRemove.push({ dir: projectSkillDir, type: 'project' })
    }
  } else {
    // Normal mode: ask where to remove from
    if (personalExists && projectExists) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'removeFrom',
          message: `Skill "${skillName}" is installed in both locations. Where do you want to remove it from?`,
          choices: [
            {
              name: 'Personal Skills (global)',
              value: 'personal',
              short: 'Personal'
            },
            {
              name: 'Project Skills (local)',
              value: 'project',
              short: 'Project'
            },
            {
              name: 'Both locations',
              value: 'both',
              short: 'Both'
            }
          ]
        }
      ])

      if (answer.removeFrom === 'personal') {
        dirsToRemove = [{ dir: personalSkillDir, type: 'personal' }]
      } else if (answer.removeFrom === 'project') {
        dirsToRemove = [{ dir: projectSkillDir, type: 'project' }]
      } else {
        dirsToRemove = [
          { dir: personalSkillDir, type: 'personal' },
          { dir: projectSkillDir, type: 'project' }
        ]
      }
    } else if (personalExists) {
      dirsToRemove = [{ dir: personalSkillDir, type: 'personal' }]
    } else {
      dirsToRemove = [{ dir: projectSkillDir, type: 'project' }]
    }

    // Confirm deletion
    const confirmation = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmDelete',
        message: `Are you sure you want to remove "${skillName}"?`,
        default: false
      }
    ])

    if (!confirmation.confirmDelete) {
      console.log(chalk.yellow('Removal cancelled'))
      console.log()
      return
    }
  }

  // Remove the skill(s)
  const spinner = ora('Removing skill...').start()

  try {
    for (const { dir, type } of dirsToRemove) {
      fs.rmSync(dir, { recursive: true, force: true })
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

/**
 * Remove all skills command handler
 */
async function removeAllSkillsCommand(force = false) {
  // Get all installed skills
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills')

  const personalSkills = getSkillsFromDirectory(personalSkillsDir)
  const projectSkills = getSkillsFromDirectory(projectSkillsDir)

  const totalSkills = personalSkills.length + projectSkills.length

  if (totalSkills === 0) {
    console.log(chalk.yellow('No skills installed'))
    console.log()
    return
  }

  if (!force) {
    // Show what will be deleted
    console.log(chalk.bold('Skills to be removed:'))
    console.log()

    if (personalSkills.length > 0) {
      console.log(chalk.green('Personal Skills:'))
      personalSkills.forEach(skill => {
        console.log(chalk.dim(`  - /${skill.name}`))
      })
      console.log()
    }

    if (projectSkills.length > 0) {
      console.log(chalk.yellow('Project Skills:'))
      projectSkills.forEach(skill => {
        console.log(chalk.dim(`  - /${skill.name}`))
      })
      console.log()
    }

    console.log(chalk.bold.red(`Total: ${totalSkills} skill${totalSkills !== 1 ? 's' : ''} will be deleted`))
    console.log()

    // Confirm deletion
    const confirmation = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmDelete',
        message: chalk.red('Are you absolutely sure you want to remove ALL skills?'),
        default: false
      }
    ])

    if (!confirmation.confirmDelete) {
      console.log(chalk.yellow('Removal cancelled'))
      console.log()
      return
    }
  }

  // Remove all skills
  const spinner = ora('Removing all skills...').start()

  try {
    let removedCount = 0

    // Remove personal skills
    if (personalSkills.length > 0 && fs.existsSync(personalSkillsDir)) {
      for (const skill of personalSkills) {
        const skillDir = path.join(personalSkillsDir, skill.name)
        if (fs.existsSync(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true })
          removedCount++
        }
      }
    }

    // Remove project skills
    if (projectSkills.length > 0 && fs.existsSync(projectSkillsDir)) {
      for (const skill of projectSkills) {
        const skillDir = path.join(projectSkillsDir, skill.name)
        if (fs.existsSync(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true })
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

/**
 * Download skill command handler
 */
async function downloadSkillCommand(skillName, downloadPath) {
  // Validate skill name (fetchSkill also validates, but do it early)
  try {
    skillName = validateSkillName(skillName)
  } catch (error) {
    console.log(chalk.red(`✗ ${error.message}`))
    process.exit(1)
  }

  // Use current directory if no path specified
  if (!downloadPath) {
    downloadPath = process.cwd()
  }

  // Fetch skill
  const skill = await fetchSkill(skillName)

  // Display skill info
  displaySkillInfo(skill)
  console.log()

  // Resolve download path
  const resolvedPath = path.resolve(downloadPath)
  const targetDir = path.join(resolvedPath, skill.skillName)

  const spinner = ora('Downloading skill...').start()

  try {
    // Create target directory
    if (fs.existsSync(targetDir)) {
      spinner.text = 'Removing existing directory...'
      fs.rmSync(targetDir, { recursive: true, force: true })
    }

    spinner.text = 'Creating directory...'
    fs.mkdirSync(targetDir, { recursive: true })

    // Write SKILL.md
    spinner.text = 'Writing files...'
    const skillMdPath = path.join(targetDir, 'SKILL.md')
    fs.writeFileSync(skillMdPath, skill.skillMd || '', 'utf8')

    // Write additional files
    if (skill.files && skill.files.length > 0) {
      for (const file of skill.files) {
        // Security: Prevent path traversal attacks
        const normalizedPath = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, '')
        const filePath = path.join(targetDir, normalizedPath)

        // Verify that the final path is still within targetDir
        const resolvedFilePath = path.resolve(filePath)
        const resolvedTargetDir = path.resolve(targetDir)

        if (!resolvedFilePath.startsWith(resolvedTargetDir + path.sep) && resolvedFilePath !== resolvedTargetDir) {
          console.warn(chalk.yellow(`⚠ Skipping potentially unsafe file path: ${file.path}`))
          continue
        }

        const fileDir = path.dirname(filePath)

        // Create subdirectories if needed
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true })
        }

        fs.writeFileSync(filePath, file.content || '', 'utf8')
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

/**
 * List installed skills command handler
 */
async function listInstalledSkillsCommand() {
  // Get personal skills
  const personalSkillsDir = path.join(os.homedir(), '.claude', 'skills')
  const personalSkills = getSkillsFromDirectory(personalSkillsDir)

  // Get project skills
  const projectSkillsDir = path.join(process.cwd(), '.claude', 'skills')
  const projectSkills = getSkillsFromDirectory(projectSkillsDir)

  // Display personal skills
  console.log(chalk.bold.green('📦 Personal Skills') + chalk.dim(` (global)`))
  console.log(chalk.dim(`   ${personalSkillsDir}`))

  if (personalSkills.length > 0) {
    const skillContents = personalSkills.map(skill => {
      let content = chalk.bold.cyan(`/${skill.name}`)

      if (skill.description) {
        content += '\n' + chalk.white(skill.description)
      }

      if (skill.version) {
        content += '\n' + chalk.dim(`Version: ${skill.version}`)
      }

      return content
    })

    const allContent = skillContents.join('\n\n')

    console.log(boxen(allContent, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 0, bottom: 0, left: 2, right: 0 },
      borderStyle: 'round',
      borderColor: 'cyan',
      width: 70
    }))
    console.log()
  } else {
    console.log(chalk.dim('   No personal skills installed'))
    console.log()
  }

  // Display project skills
  console.log(chalk.bold.yellow('📁 Project Skills') + chalk.dim(` (current directory)`))
  console.log(chalk.dim(`   ${projectSkillsDir}`))

  if (projectSkills.length > 0) {
    const skillContents = projectSkills.map(skill => {
      let content = chalk.bold.cyan(`/${skill.name}`)

      if (skill.description) {
        content += '\n' + chalk.white(skill.description)
      }

      if (skill.version) {
        content += '\n' + chalk.dim(`Version: ${skill.version}`)
      }

      return content
    })

    const allContent = skillContents.join('\n\n')

    console.log(boxen(allContent, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 0, bottom: 0, left: 2, right: 0 },
      borderStyle: 'round',
      borderColor: 'yellow',
      width: 70
    }))
    console.log()
  } else {
    console.log(chalk.dim('   No project skills installed'))
    console.log()
  }

  // Summary
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

/**
 * Create skill on SkillsCokac API
 */
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
    // Handle 409 Conflict (skill name already exists)
    if (error.response && error.response.status === 409) {
      if (!silent) {
        console.log(chalk.red('✗ Skill name already exists. Please choose a different name.'))
      }
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

/**
 * Upload skill files to SkillsCokac API
 */
async function uploadSkillFiles(skillId, skillDir, apiKey, silent = false) {
  let uploadedCount = 0
  let failedCount = 0
  const files = []

  // Recursively find all files in the directory
  function findFiles(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip hidden directories and common ignore patterns
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') {
          continue
        }
        findFiles(fullPath, baseDir)
      } else if (entry.isFile()) {
        // Skip SKILL.md at root level (already uploaded as main content)
        const relativePath = path.relative(baseDir, fullPath)
        if (relativePath === 'SKILL.md') {
          continue
        }

        // Skip hidden files
        if (entry.name.startsWith('.')) {
          continue
        }

        files.push({ fullPath, relativePath })
      }
    }
  }

  try {
    findFiles(skillDir, skillDir)

    if (files.length === 0) {
      return { uploadedCount: 0, failedCount: 0 }
    }

    for (const file of files) {
      try {
        // Check file size before reading
        const stats = fs.statSync(file.fullPath)
        if (stats.size > MAX_FILE_SIZE) {
          if (!silent) {
            console.warn(chalk.yellow(`⚠ Skipping large file (${Math.round(stats.size / 1024 / 1024)}MB): ${file.relativePath}`))
          }
          failedCount++
          continue
        }

        // Try to read as text
        let content
        try {
          content = fs.readFileSync(file.fullPath, 'utf8')
        } catch (err) {
          // Skip binary files
          continue
        }

        const filePayload = {
          path: file.relativePath.replace(/\\/g, '/'), // Normalize Windows paths
          content: content
        }

        const response = await axios.post(
          `${API_BASE_URL}/api/posts/${skillId}/files`,
          filePayload,
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': `skillscokac-cli/${VERSION}`
            },
            timeout: AXIOS_TIMEOUT
          }
        )

        if (response.status === 201) {
          uploadedCount++
        } else {
          failedCount++
        }
      } catch (error) {
        failedCount++
      }
    }

    return { uploadedCount, failedCount }
  } catch (error) {
    if (!silent) {
      console.error(chalk.red('Failed to upload files'))
    }
    throw error
  }
}

/**
 * Upload skill command handler
 */
async function uploadSkillCommand(skillDir, apiKey) {
  // Validate API key
  if (!apiKey) {
    console.log(chalk.red('✗ API key is required'))
    console.log(chalk.dim('Usage: npx skillscokac --upload <skillDir> --apikey <key>'))
    console.log()
    process.exit(1)
  }

  // Resolve skill directory
  const resolvedSkillDir = path.resolve(skillDir)
  const skillMdPath = path.join(resolvedSkillDir, 'SKILL.md')

  // Validate directory exists
  if (!fs.existsSync(resolvedSkillDir)) {
    console.log(chalk.red(`✗ Directory not found: ${resolvedSkillDir}`))
    console.log()
    process.exit(1)
  }

  // Validate SKILL.md exists
  if (!fs.existsSync(skillMdPath)) {
    console.log(chalk.red(`✗ SKILL.md not found in: ${resolvedSkillDir}`))
    console.log(chalk.dim('  The skill directory must contain a SKILL.md file'))
    console.log()
    process.exit(1)
  }

  let spinner
  try {
    // Step 1: Parse SKILL.md
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

    const skillData = {
      name: metadata.name,
      description: metadata.description,
      content: skillMdContent,
      visibility: 'PUBLIC',
      tags: ['claude-code', 'agent-skill']
    }

    // Step 2: Create skill
    spinner.text = 'Creating skill...'
    const skill = await createSkill(skillData, apiKey, true)

    // Step 3: Upload additional files
    spinner.text = 'Uploading files...'
    const { uploadedCount, failedCount } = await uploadSkillFiles(skill.id, resolvedSkillDir, apiKey, true)

    // Success summary
    const fileInfo = uploadedCount > 0 ? ` (${uploadedCount} file${uploadedCount !== 1 ? 's' : ''})` : ''
    spinner.succeed(chalk.green(`Uploaded: ${skillData.name}${fileInfo}`))
    console.log(chalk.cyan(`https://skills.cokac.com/p/${skill.id}`))

  } catch (error) {
    if (spinner) spinner.stop()
    // Handle 409 Conflict (skill name already exists)
    if (error.response && error.response.status === 409) {
      console.log(chalk.red('✗ Skill name already exists. Please choose a different name.'))
    } else {
      console.error(chalk.red('✗ Upload failed:'), error.message)
    }
    process.exit(1)
  }
}

/**
 * Find skill by name
 */
async function findSkillByName(skillName, apiKey) {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/skills/${skillName}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT
    })
    return response.data
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null
    }
    throw error
  }
}

/**
 * Update skill using individual API calls (alternative to batch)
 */
async function updateSkillIndividually(postId, skillMdContent, skillDir, apiKey, silent = false) {
  // Collect all files to upload
  const files = []

  function findFiles(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') {
          continue
        }
        findFiles(fullPath, baseDir)
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath)
        if (relativePath === 'SKILL.md') {
          continue
        }
        if (entry.name.startsWith('.')) {
          continue
        }

        // Check file size
        const stats = fs.statSync(fullPath)
        if (stats.size > MAX_FILE_SIZE) {
          if (!silent) {
            console.warn(chalk.yellow(`⚠ Skipping large file (${Math.round(stats.size / 1024 / 1024)}MB): ${relativePath}`))
          }
          continue
        }

        // Try to read as text
        let content
        try {
          content = fs.readFileSync(fullPath, 'utf8')
        } catch (err) {
          // Skip binary files
          continue
        }

        files.push({
          path: relativePath.replace(/\\/g, '/'),
          content: content
        })
      }
    }
  }

  findFiles(skillDir, skillDir)

  // Step 1: Update SKILL.md content
  await axios.patch(
    `${API_BASE_URL}/api/posts/${postId}`,
    { skillMd: skillMdContent },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT
    }
  )

  // Step 2: Get existing files
  const existingSkill = await axios.get(`${API_BASE_URL}/api/posts/${postId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': `skillscokac-cli/${VERSION}`
    },
    timeout: AXIOS_TIMEOUT
  })

  const existingFiles = existingSkill.data.skillFiles || []

  // Step 3: Delete existing files
  for (const file of existingFiles) {
    try {
      await axios.delete(
        `${API_BASE_URL}/api/posts/${postId}/files/${file.id}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': `skillscokac-cli/${VERSION}`
          },
          timeout: AXIOS_TIMEOUT
        }
      )
    } catch (err) {
      // Continue even if delete fails
      if (!silent) {
        console.warn(chalk.yellow(`⚠ Failed to delete file: ${file.path}`))
      }
    }
  }

  // Step 4: Create new files
  let uploadedCount = 0
  for (const file of files) {
    try {
      await axios.post(
        `${API_BASE_URL}/api/posts/${postId}/files`,
        file,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': `skillscokac-cli/${VERSION}`
          },
          timeout: AXIOS_TIMEOUT
        }
      )
      uploadedCount++
    } catch (err) {
      if (!silent) {
        console.warn(chalk.yellow(`⚠ Failed to upload file: ${file.path}`))
      }
    }
  }

  return {
    uploadedCount: uploadedCount,
    deletedCount: existingFiles.length
  }
}

/**
 * Update skill using batch API
 */
async function updateSkillWithBatch(postId, skillMdContent, skillDir, apiKey, silent = false) {
  // Collect all files to upload
  const files = []

  function findFiles(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') {
          continue
        }
        findFiles(fullPath, baseDir)
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath)
        if (relativePath === 'SKILL.md') {
          continue
        }
        if (entry.name.startsWith('.')) {
          continue
        }

        // Check file size
        const stats = fs.statSync(fullPath)
        if (stats.size > MAX_FILE_SIZE) {
          if (!silent) {
            console.warn(chalk.yellow(`⚠ Skipping large file (${Math.round(stats.size / 1024 / 1024)}MB): ${relativePath}`))
          }
          continue
        }

        // Try to read as text
        let content
        try {
          content = fs.readFileSync(fullPath, 'utf8')
        } catch (err) {
          // Skip binary files
          continue
        }

        files.push({
          path: relativePath.replace(/\\/g, '/'),
          content: content
        })
      }
    }
  }

  findFiles(skillDir, skillDir)

  // Get existing files to delete
  const existingSkill = await axios.get(`${API_BASE_URL}/api/posts/${postId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': `skillscokac-cli/${VERSION}`
    },
    timeout: AXIOS_TIMEOUT
  })

  const existingFiles = existingSkill.data.skillFiles || []

  // Prepare batch payload
  const batchPayload = {
    skillMd: skillMdContent,
    files: {
      delete: existingFiles.map(f => ({ id: f.id })),
      create: files
    }
  }

  // Execute batch update
  const response = await axios.post(
    `${API_BASE_URL}/api/posts/${postId}/files/batch`,
    batchPayload,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `skillscokac-cli/${VERSION}`
      },
      timeout: AXIOS_TIMEOUT
    }
  )

  return {
    uploadedCount: files.length,
    deletedCount: existingFiles.length
  }
}

/**
 * Upload or modify skill command handler
 */
async function uploadModifySkillCommand(skillDir, apiKey) {
  // Validate API key
  if (!apiKey) {
    console.log(chalk.red('✗ API key is required'))
    console.log(chalk.dim('Usage: npx skillscokac --uploadmodify <skillDir> --apikey <key>'))
    console.log()
    process.exit(1)
  }

  // Resolve skill directory
  const resolvedSkillDir = path.resolve(skillDir)
  const skillMdPath = path.join(resolvedSkillDir, 'SKILL.md')

  // Validate directory exists
  if (!fs.existsSync(resolvedSkillDir)) {
    console.log(chalk.red(`✗ Directory not found: ${resolvedSkillDir}`))
    console.log()
    process.exit(1)
  }

  // Validate SKILL.md exists
  if (!fs.existsSync(skillMdPath)) {
    console.log(chalk.red(`✗ SKILL.md not found in: ${resolvedSkillDir}`))
    console.log(chalk.dim('  The skill directory must contain a SKILL.md file'))
    console.log()
    process.exit(1)
  }

  let spinner
  try {
    // Step 1: Parse SKILL.md
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

    const skillName = metadata.name

    // Step 2: Check if skill exists
    spinner.text = 'Checking if skill exists...'
    const existingSkill = await findSkillByName(skillName, apiKey)

    if (existingSkill) {
      // Update existing skill
      console.log(chalk.yellow(`Skill "${skillName}" already exists. Updating...`))

      spinner.text = 'Updating skill and files...'
      const { uploadedCount, deletedCount } = await updateSkillIndividually(
        existingSkill.id,
        skillMdContent,
        resolvedSkillDir,
        apiKey,
        true
      )

      spinner.succeed(chalk.green(`Updated: ${skillName} (${uploadedCount} files)`))
      console.log(chalk.dim(`  Deleted ${deletedCount} old file${deletedCount !== 1 ? 's' : ''}, uploaded ${uploadedCount} new file${uploadedCount !== 1 ? 's' : ''}`))
      console.log(chalk.cyan(`https://skills.cokac.com/p/${existingSkill.id}`))
    } else {
      // Create new skill
      console.log(chalk.cyan(`Skill "${skillName}" does not exist. Creating new...`))

      const skillData = {
        name: metadata.name,
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

    // Handle specific errors
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

/**
 * Setup CLI with Commander
 */
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
  .option('-l, --list-installed-skills', 'List all installed skills')
  .parse(process.argv)

const options = program.opts()

// Execute command with proper async/await error handling
;(async () => {
  try {
    if (options.installSkill) {
      await installSkillCommand(options.installSkill)
    } else if (options.installCollection) {
      await installCollectionCommand(options.installCollection)
    } else if (options.download) {
      // Download expects one or two arguments: skillName and optional path
      if (options.download.length < 1 || options.download.length > 2) {
        console.log(chalk.red('✗ Invalid arguments for --download'))
        console.log(chalk.dim('Usage: npx skillscokac --download <skillName> [path]'))
        console.log()
        process.exit(1)
      }
      const [skillName, downloadPath] = options.download
      await downloadSkillCommand(skillName, downloadPath)
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
      // Show help if no options provided
      program.help()
    }
  } catch (error) {
    // Handle any uncaught errors
    console.error(chalk.red('\n✗ Unexpected error:'), error.message)
    if (process.env.DEBUG) {
      console.error(error.stack)
    }
    process.exit(1)
  }
})()
