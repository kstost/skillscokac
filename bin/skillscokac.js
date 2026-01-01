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

/**
 * Parse frontmatter from markdown content
 */
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { metadata: {}, content }
  }

  try {
    const metadata = yaml.parse(match[1])
    const markdownContent = content.slice(match[0].length).trim()
    return { metadata, content: markdownContent }
  } catch (error) {
    console.error(chalk.red('Error parsing frontmatter:'), error.message)
    return { metadata: {}, content }
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
    // Step 1: Get marketplace data to find postId
    if (spinner) spinner.text = 'Fetching marketplace data...'
    const marketplaceResponse = await axios.get(`${API_BASE_URL}/api/marketplace`, {
      headers: {
        'User-Agent': `skillscokac-cli/${VERSION}`
      }
    })

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
        }
      }
    )

    // Step 3: Extract ZIP
    if (spinner) spinner.text = 'Extracting files...'
    const zip = new AdmZip(Buffer.from(zipResponse.data))
    const zipEntries = zip.getEntries()

    // Find SKILL.md
    const skillMdEntry = zipEntries.find(entry =>
      entry.entryName.endsWith('SKILL.md') && !entry.isDirectory
    )

    if (!skillMdEntry) {
      throw new Error('Invalid skill package')
    }

    const skillMdContent = skillMdEntry.getData().toString('utf8')
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
  const spinner = ora('Fetching collection...').start()

  try {
    // Fetch collection
    const response = await axios.get(`${API_BASE_URL}/api/collections/${collectionId}`, {
      headers: {
        'User-Agent': `skillscokac-cli/${VERSION}`
      }
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
      const skillName = skillPost.skillName

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
