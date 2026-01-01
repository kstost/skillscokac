# NPM 배포 가이드

## 사전 준비

### 1. NPM 계정 설정

```bash
# NPM 로그인 (계정이 없으면 https://www.npmjs.com 에서 가입)
npm login
```

이메일: `monogatree@gmail.com`로 가입해야 합니다.

### 2. 배포 전 체크리스트

- [x] `package.json` 작성자 정보 업데이트
- [x] `README.md` 작성 완료
- [x] `LICENSE` 파일 생성
- [x] `.npmignore` 파일 생성
- [ ] Git 저장소 생성 및 코드 푸시
- [ ] 버전 번호 확인 (현재: 1.0.0)

### 3. 로컬 테스트

```bash
# 의존성 설치
npm install

# CLI 도구 테스트
node bin/skillscokac.js --help

# 스킬 설치 테스트
node bin/skillscokac.js -i <테스트-스킬-이름>

# 패키지 내용 확인
npm pack --dry-run
```

### 4. Git 저장소 설정

```bash
# Git 초기화 (아직 안 했다면)
git init

# .gitignore 파일 확인
# 원격 저장소 추가
git remote add origin https://github.com/kstost/skillscokac.git

# 첫 커밋
git add .
git commit -m "Initial commit: skillscokac CLI v1.0.0"

# GitHub에 푸시
git branch -M main
git push -u origin main
```

## NPM 배포 절차

### 1. 패키지 빌드 테스트

```bash
# 실제로 패키징하지 않고 내용 확인
npm pack --dry-run
```

포함될 파일 확인:
- `bin/skillscokac.js`
- `README.md`
- `LICENSE`
- `package.json`

### 2. 로컬 테스트 설치

```bash
# 현재 디렉토리에서 패키지 생성
npm pack

# 생성된 .tgz 파일을 전역 설치하여 테스트
npm install -g ./skillscokac-1.0.0.tgz

# 테스트
skillscokac --help
skillscokac -l

# 테스트 완료 후 제거
npm uninstall -g skillscokac
rm skillscokac-1.0.0.tgz
```

### 3. NPM 배포

```bash
# NPM에 배포 (최초)
npm publish

# 만약 패키지명이 이미 존재한다면
# package.json의 name을 변경하거나
# scoped package 사용: "@yourusername/skillscokac"
```

### 4. 배포 확인

```bash
# NPM에서 패키지 정보 확인
npm view skillscokac

# 전역 설치 테스트
npm install -g skillscokac

# 실행 테스트
skillscokac --help

# 또는 npx로 테스트
npx skillscokac --help
```

## 버전 업데이트 및 재배포

```bash
# 패치 버전 업데이트 (1.0.0 -> 1.0.1)
npm version patch

# 마이너 버전 업데이트 (1.0.0 -> 1.1.0)
npm version minor

# 메이저 버전 업데이트 (1.0.0 -> 2.0.0)
npm version major

# Git 태그와 함께 커밋됨
git push && git push --tags

# 새 버전 배포
npm publish
```

## 배포 후 확인 사항

1. **NPM 페이지 확인**
   - https://www.npmjs.com/package/skillscokac

2. **설치 테스트**
   ```bash
   npx skillscokac -i <skill-name>
   ```

3. **README 렌더링 확인**
   - NPM 페이지에서 README가 제대로 표시되는지 확인

4. **GitHub 저장소 연동 확인**
   - NPM 페이지에서 GitHub 링크가 제대로 작동하는지 확인

## 문제 해결

### 패키지명이 이미 존재하는 경우

```bash
# npm 검색으로 확인
npm search skillscokac

# 이름 변경이 필요하면 package.json 수정
# 예: "name": "@codejogak/skillscokac"
```

### 배포 권한 오류

```bash
# NPM 로그아웃 후 재로그인
npm logout
npm login
```

### 파일이 누락되는 경우

`package.json`의 `files` 필드 확인:
```json
"files": [
  "bin/",
  "README.md",
  "LICENSE"
]
```

## 유용한 명령어

```bash
# 현재 로그인된 사용자 확인
npm whoami

# 패키지 정보 확인
npm view skillscokac

# 모든 버전 확인
npm view skillscokac versions

# 패키지 다운로드 통계
npm view skillscokac

# 배포 취소 (24시간 이내, 주의!)
npm unpublish skillscokac@1.0.0
```

## 참고사항

- **배포 취소는 24시간 이내만 가능**하며, 이후에는 NPM 지원팀에 문의해야 합니다
- 같은 버전 번호로 재배포할 수 없으므로 **신중하게 배포**하세요
- **patch/minor/major 버전 규칙**을 따라 의미있는 버전 관리를 하세요
- 배포 전 **반드시 로컬에서 충분히 테스트**하세요
