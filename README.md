# Iminify Image Compression

A GitHub Action that compresses the images a pull request adds or changes with [Iminify](https://www.iminify.com), commits the smaller files to the pull request's branch, and leaves a comment with what each one saved.

```text
Iminify compressed 2 images and saved 1.31 MB (71.8%). The smaller files are in 4f0c2e1.

| Image                  | Before   | After    | Saved |
| ---------------------- | -------- | -------- | ----- |
| public/img/hero.png    | 1.42 MB  | 318.6 KB | 78.1% |
| public/img/team.jpg    | 412.0 KB | 199.3 KB | 51.6% |
```

## Setup

1. Sign in at [iminify.com](https://www.iminify.com) and create a token under **Settings > API Tokens**. The account's email must be verified.
2. In your repository, add the token as a secret named `IMINIFY_TOKEN` (**Settings > Secrets and variables > Actions**).
3. Add a workflow, for example `.github/workflows/images.yml`:

```yaml
name: Images

on:
  pull_request:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: images-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  compress:
    runs-on: ubuntu-latest
    steps:
      - uses: mozex/iminify-action@v1
        with:
          token: ${{ secrets.IMINIFY_TOKEN }}
```

The action reads the files through GitHub's API, so the job needs no checkout step. The `permissions` block matters: many repositories give workflows a read-only token, and the action needs to push a commit and write a comment. The `concurrency` group cancels a run when a newer push to the same branch arrives.

## What it does

- It looks at the PNG, JPG, WebP and GIF files the pull request adds or changes. HEIC and TIFF files are left alone because Iminify always returns them in another format, and a new extension would break every reference to the file.
- It sends each one to Iminify with alt text off and its format kept, at the level you choose.
- Files that came back smaller go into one commit on the pull request's branch. GitHub signs it, and since it's made with the workflow's own token, it doesn't start another workflow run.
- The comment lists every file with its size before and after. The action updates the same comment on each push instead of adding a new one.
- It never sends the same bytes twice. Its own commits name the files they wrote, and the comment remembers the images Iminify couldn't make smaller, so a later push only sends what's new.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | | Your Iminify API token. Pass it from a secret. |
| `github-token` | `${{ github.token }}` | Reads the pull request, commits to its branch and writes the comment. |
| `level` | `smart` | `smart` finds the lowest quality that still looks like the original, `ultra` goes a little further, and `lossless` changes no pixel. |
| `keep-metadata` | `false` | Keep the EXIF metadata (camera, date, location). By default it's stripped. |
| `commit` | `true` | Commit the smaller files. With `false`, the action only reports what it would save. |
| `comment` | `true` | Write the savings in a pull request comment. |
| `ignore` | | Paths to leave alone, one pattern per line. A pattern without a slash matches a file name in any folder (`*.gif`), one with a slash starts at the repository root (`tests/fixtures/`), and `**` crosses folders. |

## Outputs

| Output | Description |
| --- | --- |
| `compressed` | How many images came back smaller. |
| `saved-bytes` | The bytes those images saved together. |
| `commit` | The sha of the commit with the smaller files, or empty when there's none. |

## Your plan's limits

Every image the action sends counts against your Iminify plan's daily images, the same count the website and the API use. The [pricing page](https://www.iminify.com/pricing) lists each plan's numbers. If the day's images run out partway through, the action commits what it finished, lists the rest in the comment, and sends them again on the next push.

The images also show up in your Iminify account like any other upload, where you can download or delete them. The [privacy policy](https://www.iminify.com/privacy-policy) says what Iminify keeps and for how long.

## Forks and Dependabot

GitHub doesn't give a pull request from a fork your secrets or a token that can push to its branch, and Dependabot's pull requests don't get your Actions secrets either. The action skips both with a notice instead of failing. Compress those images in a pull request from a branch of your own repository, or after merging.

Don't switch the workflow to `pull_request_target` to get around this. That event runs with your secrets for anyone's pull request, so the action refuses to run on it.

## Required status checks

A commit made with the workflow's own token doesn't start workflow runs, so required checks on the new head commit wait until the next push. If that gets in the way, pass a personal access token or a GitHub App token as `github-token`. Its commit starts a new run, and that run finds nothing new to send.

## License

MIT
