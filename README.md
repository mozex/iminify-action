# Iminify Image Compression

A GitHub Action that compresses the images a pull request adds or changes with [Iminify](https://www.iminify.com), commits the smaller files to the pull request's branch, and leaves a comment with what each one saved.

```text
Iminify compressed 2 images and saved 1.32 MB (72.2%). The smaller files are in 4f0c2e1.

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

- It looks at the PNG, JPG, WebP and GIF files the pull request adds or changes. A file only moved or copied, with the same bytes, isn't sent again. HEIC and TIFF files are left alone because Iminify always returns them in another format, and a new extension would break every reference to the file.
- It checks each file's first bytes before sending it. A file whose bytes don't match its extension (a PNG named `.jpg`) is left alone, and so is a file stored in Git LFS: the action reads only what's in Git itself.
- It sends each one to Iminify with alt text off and its format kept, at the level you choose.
- Files that came back smaller go into one commit on the pull request's branch, made with the workflow's own token and signed by GitHub as `github-actions[bot]`.
- The comment lists every file with its size before and after. The action updates the same comment on each push instead of adding a new one.
- A later push sends only what's new. The action's commits name the files they wrote, and its comment remembers the images Iminify couldn't make smaller and the files it left alone. An image that failed is sent again. With `comment: false`, so is an image Iminify couldn't make smaller, since only the comment remembers it, and with `commit` and `comment` both off, every image is sent again on every push.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `token` | | Your Iminify API token. Pass it from a secret. |
| `github-token` | `${{ github.token }}` | Reads the pull request, commits to its branch and writes the comment. |
| `level` | `smart` | `smart` finds the lowest quality that still looks like the original, `ultra` goes a little further, and `lossless` changes no pixel. |
| `keep-metadata` | `false` | Keep the EXIF metadata (camera, date, location). By default it's stripped. |
| `commit` | `true` | Commit the smaller files. With `false`, the action only reports what it would save. |
| `comment` | `true` | Write the savings in a pull request comment. With `false`, images Iminify couldn't make smaller are sent again on every push. |
| `ignore` | | Paths to leave alone, one pattern per line, read like `.gitignore` patterns without `!` or `[...]`. A pattern with no slash, or only one at its end, matches at any depth (`*.gif`, `fixtures`), one with a slash before its end starts at the repository root (`tests/fixtures`), a pattern that names a folder covers everything in it, and `**` crosses folders. |

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

GitHub doesn't run workflows on a commit made with the workflow's own token by itself: it holds those runs until someone with write access approves them on the pull request, so required checks on the action's commit wait for that approval or for the next push. The approved run of this action finds nothing new and sends nothing. To have the checks start on their own, pass a personal access token or a GitHub App token as `github-token`.

## License

MIT
