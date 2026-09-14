class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  version "0.1.0"
  license "MIT"

  depends_on "node@22"
  depends_on "anomalyco/tap/opencode"
  depends_on "tmux"
  depends_on "jq"
  depends_on "python@3.14"
  depends_on "git"
  depends_on "uv"
  depends_on "ripgrep"

  def install
    libexec.install "bin", "core", "shared", "teams", "tests", "VERSION"
    bin.write_exec_script libexec/"bin/opencode-team"
  end

  test do
    assert_match "OpenCode Team 0.1.0", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
  end
end
