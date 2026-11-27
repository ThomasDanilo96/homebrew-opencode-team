#!/usr/bin/env ruby

require "digest"
require "fileutils"
require "json"
require "open3"
require "rubygems/package"
require "shellwords"
require "stringio"
require "zlib"

RUNTIME_TARGETS = {
  "darwin-arm64" => %w[macos arm],
  "darwin-x64" => %w[macos intel],
  "linux-arm64" => %w[linux arm],
  "linux-x64-baseline" => %w[linux intel],
}.freeze

def runtime_resources(version, lock, local_directory)
  abort "Session Guard runtime is for v0.3.13 only" unless version == "0.3.13"
  targets = lock.keys
  abort "invalid runtime target set" unless targets.any? && (targets - RUNTIME_TARGETS.keys).empty?
  abort "official formula requires all runtime targets" unless local_directory || targets.sort == RUNTIME_TARGETS.keys.sort
  targets.sort.map do |target|
    os, arch = RUNTIME_TARGETS.fetch(target)
    asset = lock.fetch(target)
    digest, size = asset.values_at("sha256", "bytes")
    abort "invalid runtime asset lock: #{target}" unless /\A[0-9a-f]{64}\z/.match?(digest) && size.is_a?(Integer) && size.positive?
    filename = "opencode-team-runtime-2.3.2-#{target}.tar.gz"
    url = "https://github.com/ThomasDanilo96/homebrew-opencode-team/releases/download/v#{version}/#{filename}"
    if local_directory
      file = File.join(File.realpath(local_directory), filename)
      abort "runtime asset mismatch: #{target}" if File.symlink?(file) || !File.file?(file) ||
        File.size(file) != size || Digest::SHA256.file(file).hexdigest != digest
      url = "file://#{file}"
    end
    <<~RUBY.lines.map { |line| "  #{line}" }.join.chomp
      on_#{os} do
        on_#{arch} do
          resource "team-runtime" do
            url #{url.dump}
            sha256 #{digest.dump}
          end
        end
      end
    RUBY
  end.join("\n\n")
end

def render_formula(source, class_name, version, url, sha256, runtime: nil)
  abort "invalid Formula class name" unless class_name.match?(/\A[A-Z][A-Za-z0-9]*\z/)
  abort "invalid stable version" unless version.match?(/\A\d+\.\d+\.\d+\z/)
  abort "invalid SHA-256" unless sha256.match?(/\A[0-9a-f]{64}\z/)
  abort "only file and HTTPS staging URLs are permitted" unless url.start_with?("file://", "https://")

  source = source.dup
  source.sub!(/^class OpencodeTeam < Formula$/, "class #{class_name} < Formula") || abort("source formula class not found")
  source.gsub!(/^  disable! .*\n/, "")
  source.sub!(/^  url .*$/, "  url #{url.dump}") || abort("source formula URL not found")
  source.sub!(/^(  url .*\n)/) { "#{$1}  version #{version.dump}\n" } || abort("could not set staging formula version")
  source.sub!(/^  sha256 .*$/, "  sha256 #{sha256.dump}") || abort("source formula SHA-256 not found")
  abort "source formula license not found" unless source.match?(/^  license /)
  abort "v0.3.13 requires verified Session Guard runtime resources" if version == "0.3.13" && !runtime
  if runtime
    install = <<~'RUBY'
      odie "No checksum-locked Session Guard runtime for this OS/architecture" unless resources.any? { |r| r.name == "team-runtime" }
      resource("team-runtime").stage do
        (libexec/"runtime").install "opencode", "manifest.json", "LICENSE"
      end
      (libexec/".requires-session-guard").write "#{opt_prefix}/libexec\n"
    RUBY
    test_runtime = <<~'RUBY'
      assert_predicate libexec/"runtime/opencode", :executable?
      testpath.join("home").mkpath
      ENV["HOME"] = testpath.join("home").realpath.to_s
      ENV["OPENCODE_TEAM_HOME"] = testpath.realpath.join("profiles").to_s
      %w[best free].each do |profile|
        config = testpath/"profiles/config/#{profile}"
        (config/"v2").mkpath
        (config/"opencode.jsonc").write("{}\n")
        (config/"v2/AGENTS.md").write("# Isolated Homebrew test\n")
        assert_equal "opencode v2.3.2", shell_output("#{bin}/opencode-team #{profile} --version").strip
      end
    RUBY
    source.sub!("  def install\n") { "#{runtime}\n\n  def install\n#{install.lines.map { |line| "    #{line}" }.join}" } ||
      abort("template install method not found")
    source.sub!("  test do\n") { "  test do\n#{test_runtime.lines.map { |line| "    #{line}" }.join}" } ||
      abort("template test block not found")
  end

  # Stable and staging distributions use the same guarded test surface. Only
  # artifact identity changes; do not rewrite partial multiline install statements.
  abort("source formula must install guarded smoke tests") unless source.include?('assert_predicate libexec/"tests/guardrail/runner.sh", :executable?')

  source
end

def archive_files(archive, commit, source = nil)
  abort "INVALID_COMMIT" unless commit.match?(/\A[0-9a-f]{40}\z/)
  tar = Zlib::GzipReader.open(archive, &:read)
  # Git's global pax header contains the commit; no checkout or network needed.
  actual, _, status = Open3.capture3("git", "get-tar-commit-id", stdin_data: tar.byteslice(0, 10240))
  abort "ARCHIVE_COMMIT_MISMATCH" unless status.success? && actual.strip == commit
  files = {}
  prefix = nil
  Gem::Package::TarReader.new(StringIO.new(tar)) do |reader|
    reader.each do |entry|
      next if entry.header.typeflag == "g"
      parts = entry.full_name.split("/")
      abort "UNSAFE_ARCHIVE_PATH" if entry.full_name.start_with?("/") || parts.any? { |p| p.empty? || p == "." || p == ".." }
      prefix ||= parts.first
      abort "UNSUPPORTED_ARCHIVE_ENTRY" unless parts.first == prefix && (entry.file? || entry.directory?)
      next if entry.directory?
      name = parts.drop(1).join("/")
      abort "DUPLICATE_OR_UNROOTED_ARCHIVE_ENTRY" if name.empty? || files.key?(name)
      files[name] = entry.read
    end
  end
  %w[VERSION Formula/opencode-team.rb .github/scripts/render-staging-formula.rb tests/guardrail/runner.sh tests/packaging.test.mjs].each do |name|
    abort "MISSING_ARCHIVE_FILE: #{name}" unless files.key?(name)
  end
  if source
    expected, _, status = Open3.capture3("git", "-C", source, "archive", "--format=tar", "--prefix=#{prefix}/", commit)
    abort "ARCHIVE_TREE_MISMATCH" unless status.success? && expected.b == tar.b
  end
  files
end

def verify_source(files, root)
  root = File.realpath(root)
  files.each do |name, bytes|
    parts = name.split("/")
    linked = (1..parts.length).any? { |n| File.symlink?(File.join(root, *parts.take(n))) }
    file = File.join(root, name)
    abort "SOURCE_MISMATCH: #{name}" if linked || !File.file?(file) || File.binread(file) != bytes
  end
end

def operations(bundle, source, commit, sha, verifier_sha)
  verifier = Shellwords.escape(File.join(bundle, "verify-release.rb"))
  target = Shellwords.escape(bundle)
  runner = Shellwords.escape(File.join(source, "tests/guardrail/runner.sh"))
  formula = Shellwords.escape(File.join(bundle, "opencode-team-staging.rb"))
  check = "printf '%s  %s\\n' #{verifier_sha} #{verifier} | shasum -a 256 -c - &&\n" \
    "ruby #{verifier} --verify #{target} #{commit} #{sha}"
  <<~TEXT
    # Candidate #{commit}

    Archive SHA-256: #{sha}

    Complete preparation (packaging plus archive/source/handoff checks; no installation):

    ```sh
    bash #{runner} packaging #{target} #{commit} #{sha}
    ```

    Check identity and completeness only (does not certify packaging):

    ```sh
    #{check}
    ```

    Installation command, ONLY after separate GO and successful preparation:
    Requires a fresh staging tap; an existing tap is a blocker, not permission
    to overwrite it. No unlink/force or profile setup is performed.

    ```sh
    #{check} &&
    brew tap-new --no-git opencode-team/staging &&
    tap="$(brew --repo opencode-team/staging)" &&
    cp #{formula} "$tap/Formula/opencode-team-staging.rb" &&
    cmp #{formula} "$tap/Formula/opencode-team-staging.rb" &&
    brew install --formula opencode-team/staging/opencode-team-staging
    ```

    Packaging/preparation is not operational qualification or incident closure.
    No setup, quarantine/journal changes, publication or capture is authorized.
  TEXT
end

def verify_handoff(bundle, commit, sha, source = nil)
  bundle = File.realpath(bundle)
  names = %w[release.json archive.tar.gz opencode-team-staging.rb OPERATIONS.md verify-release.rb]
  names.each do |name|
    file = File.join(bundle, name)
    abort "MISSING_HANDOFF_FILE: #{name}" unless File.file?(file) && !File.symlink?(file) && File.size(file) > 0
  end
  info = JSON.parse(File.read(File.join(bundle, "release.json")))
  abort "HANDOFF_IDENTITY_MISMATCH" unless info.fetch("commit") == commit && info.fetch("archive_sha256") == sha
  abort "HANDOFF_SOURCE_MISMATCH" if source && File.realpath(source) != info.fetch("source")
  archive = File.join(bundle, "archive.tar.gz")
  abort "ARCHIVE_SHA256_MISMATCH" unless Digest::SHA256.file(archive).hexdigest == sha
  files = archive_files(archive, commit, source)
  version = files.fetch("VERSION").strip
  resources = nil
  if (assets = info["runtime_assets"])
    lock = File.join(bundle, "runtime-lock.json")
    abort "RUNTIME_LOCK_MISMATCH" if File.symlink?(lock) || !File.file?(lock) ||
      Digest::SHA256.file(lock).hexdigest != info.fetch("runtime_lock_sha256")
    resources = runtime_resources(version, JSON.parse(File.read(lock)), assets)
  end
  expected = render_formula(files.fetch("Formula/opencode-team.rb"), "OpencodeTeamStaging",
    version, "file://#{archive}", sha, runtime: resources)
  abort "FORMULA_ARTIFACT_MISMATCH" unless File.read(File.join(bundle, "opencode-team-staging.rb")) == expected
  verifier_sha = Digest::SHA256.hexdigest(files.fetch(".github/scripts/render-staging-formula.rb"))
  abort "OPERATIONS_MISMATCH" unless File.read(File.join(bundle, "OPERATIONS.md")) == operations(bundle, info.fetch("source"), commit, sha, verifier_sha)
  abort "VERIFIER_ARTIFACT_MISMATCH" unless File.binread(File.join(bundle, "verify-release.rb")) == files.fetch(".github/scripts/render-staging-formula.rb")
  verify_source(files, source) if source
  puts "HANDOFF_VALID commit=#{commit} sha256=#{sha} packaging=NOT_EVALUATED installation=NOT_AUTHORIZED"
end

if ARGV.first == "--handoff" && [5, 6].include?(ARGV.length)
  _, archive, commit, source, bundle, assets = ARGV
  source = File.realpath(source)
  head, _, status = Open3.capture3("git", "-C", source, "rev-parse", "HEAD")
  abort "SOURCE_COMMIT_MISMATCH" unless status.success? && head.strip == commit
  files = archive_files(archive, commit, source)
  verify_source(files, source)
  abort "GENERATOR_ARTIFACT_MISMATCH" unless File.binread(__FILE__) == files.fetch(".github/scripts/render-staging-formula.rb")
  bundle = File.expand_path(bundle)
  Dir.mkdir(bundle, 0700) # Refuse to overwrite a previous handoff.
  bundle = File.realpath(bundle)
  target = File.join(bundle, "archive.tar.gz")
  FileUtils.copy_file(archive, target)
  sha = Digest::SHA256.file(target).hexdigest
  version = files.fetch("VERSION").strip
  manifest = { commit: commit, archive_sha256: sha, source: source }
  resources = nil
  if assets
    assets = File.realpath(assets)
    lock = File.join(bundle, "runtime-lock.json")
    FileUtils.copy_file(File.join(assets, "runtime-lock.json"), lock)
    resources = runtime_resources(version, JSON.parse(File.read(lock)), assets)
    manifest.merge!(runtime_assets: assets, runtime_lock_sha256: Digest::SHA256.file(lock).hexdigest)
  end
  File.write(File.join(bundle, "opencode-team-staging.rb"),
    render_formula(files.fetch("Formula/opencode-team.rb"), "OpencodeTeamStaging", version, "file://#{target}", sha, runtime: resources))
  verifier_sha = Digest::SHA256.hexdigest(files.fetch(".github/scripts/render-staging-formula.rb"))
  File.write(File.join(bundle, "OPERATIONS.md"), operations(bundle, source, commit, sha, verifier_sha))
  File.binwrite(File.join(bundle, "verify-release.rb"), files.fetch(".github/scripts/render-staging-formula.rb"))
  File.write(File.join(bundle, "release.json"), JSON.pretty_generate(manifest) + "\n")
  Dir.children(bundle).each { |name| File.chmod(0600, File.join(bundle, name)) }
  verify_handoff(bundle, commit, sha, source)
elsif ARGV.first == "--verify" && [4, 5].include?(ARGV.length)
  verify_handoff(*ARGV.drop(1))
elsif ARGV.first == "--runtime" && [8, 9].include?(ARGV.length)
  _, source_path, output_path, class_name, version, url, sha256, lock, directory = ARGV
  source = File.read(source_path)
  resources = runtime_resources(version, JSON.parse(File.read(lock)), directory)
  File.write(output_path, render_formula(source, class_name, version, url, sha256, runtime: resources))
elsif ARGV.length == 6
  source_path, output_path, class_name, version, url, sha256 = ARGV
  File.write(output_path, render_formula(File.read(source_path), class_name, version, url, sha256))
else
  abort "usage: render-staging-formula.rb [--runtime] SOURCE_FORMULA OUTPUT_FORMULA CLASS VERSION URL SHA256 [LOCK [LOCAL_ASSETS]]\n" \
    "  --handoff ARCHIVE COMMIT SOURCE_ROOT NEW_OUTPUT_DIRECTORY [LOCAL_RUNTIME_ASSETS]\n  --verify BUNDLE COMMIT SHA256 [SOURCE_ROOT]"
end
