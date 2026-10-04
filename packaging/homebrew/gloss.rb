# Made from packaging/homebrew/gloss.rb in ryanbrunner/gloss, whose release
# workflow fills in url and sha256 for each tag and pushes the result to
# ryanbrunner/homebrew-tap. Change it there: the tap's copy is overwritten.
class Gloss < Formula
  desc "Review a running web app in a browser and hand the comments to Claude"
  homepage "https://github.com/ryanbrunner/gloss"
  url "https://github.com/ryanbrunner/gloss/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    # Pinned to Homebrew's node rather than whichever is first on PATH, for
    # gloss and for the session process it starts with the same node.
    (bin/"gloss").write_env_script libexec/"bin/gloss", PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  def caveats
    <<~EOS
      Gloss drives a Chromium of its own. Download it once (about 150 MB,
      into Playwright's cache: ~/Library/Caches/ms-playwright on macOS,
      ~/.cache/ms-playwright on Linux):
        gloss install-chromium

      On Linux, add --with-deps to also install the system libraries
      Chromium needs to launch (apt, via sudo):
        gloss install-chromium --with-deps

      To run reviews from Claude Code, add the plugin there:
        /plugin marketplace add ryanbrunner/gloss
        /plugin install gloss@gloss
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/gloss --version").strip
    # No browser and no network: just that gloss starts and answers.
    ENV["GLOSS_HOME"] = testpath
    assert_match '"running": false', shell_output("#{bin}/gloss status --json", 1)
  end
end
