# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.7] - 2026-01-06

### Changed
- Relaxed ZIP compression ratio limit from 10:1 to 1250:1 to accommodate legitimately highly-compressed files

## [1.5.6] - 2026-01-06

### Security
- Enhanced skill name validation with stricter rules (lowercase only, no underscores, 64 character limit)
- Added comprehensive file system security with safe operation functions
- Implemented symlink attack prevention in file operations
- Enhanced ZIP file security with file count limit (1000 files max)
- Improved compression ratio validation (10:1 max) to prevent ZIP bombs
- Added file path length validation (255 characters max)
- Strengthened path traversal protection

### Added
- Debug logging system with `DEBUG` flag for troubleshooting
- `validatePathWithinBase` function for secure path validation
- `safeWriteFile` function for secure file write operations
- `safeRemoveDirectory` function for secure directory deletion
- `safeCreateDirectory` function for secure directory creation
- `normalizeUntrustedPath` function for path normalization
- Enhanced validation error messages with specific guidance

### Improved
- Code quality through extensive refactoring and simplification
- Removed redundant comments and documentation
- Consolidated duplicate code into reusable functions
- Optimized error handling and validation flow
- Better separation of concerns in file operations

## [1.5.4] - 2026-01-06

### Improved
- Enhanced error handling with `validateSkillNameOrExit` helper function for consistent error reporting
- Added comprehensive JSDoc comments for better code documentation
- Improved code quality and readability through refactoring
- Unified validation error messages across all command handlers

### Removed
- Removed internal `NPM_PUBLISH_GUIDE.md` documentation file

## [1.5.3] - 2026-01-05

### Changed
- License changed from ISC to MIT

### Added
- Download command (`-d, --download`) to download skills to custom directories without installing
- Upload command (`-u, --upload`) to publish new skills to skills.cokac.com marketplace
- Upload/modify command (`-m, --uploadmodify`) to create or update skills on marketplace
- API key support (`--apikey`) for skill upload operations
- Comprehensive security enhancements:
  - YAML bomb protection with alias expansion limits
  - ZIP bomb detection with compression ratio validation
  - Path traversal protection for ZIP file entries
  - ReDoS (Regular Expression Denial of Service) protection
  - Strict input validation for collection IDs and skill names
  - File content size validation and limits
  - Network request validation with content-type checks
- Automatic YAML frontmatter preprocessing for special characters
- Security section in README documentation
- Extended documentation for new upload/download features

### Improved
- Error messages for invalid inputs and security violations
- Handling of malformed SKILL.md files
- Network request timeout and redirect limits

## [1.5.2] - 2025-XX-XX

### Fixed
- Previous bug fixes and improvements

## Earlier Versions

See [npm package history](https://www.npmjs.com/package/skillscokac) for earlier versions.
