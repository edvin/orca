//! Orca's Lima VM when it doesn't come up: keeping its boot from stopping at
//! a prompt nobody can see, reading its console, finding its disk's
//! filesystems for a rescue, and gathering what an AI tool (or a person)
//! needs to work out what's wrong.
//!
//! What happened once: the VM's disk returned I/O errors, Linux marked its
//! filesystem as having errors, and from then on every boot stopped in the
//! initramfs at "UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY". That prompt
//! went to `ttyAMA0`, which Lima doesn't record, so the VM sat idle while
//! Orca restarted it again and again.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set while System Health's rescue works on the VM, so the daemon's own
/// recovery doesn't stop or start it underneath (a force-stop during
/// `e2fsck` would be the worst moment).
static RESCUE_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn rescue_running() -> bool {
    RESCUE_RUNNING.load(Ordering::SeqCst)
}

/// Marks a rescue as running until dropped.
pub struct RescueGuard(());

impl RescueGuard {
    /// `None` when a rescue is running already.
    pub fn take() -> Option<Self> {
        RESCUE_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self(()))
    }
}

impl Drop for RescueGuard {
    fn drop(&mut self) {
        RESCUE_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Where the guest keeps the setting below.
pub const BOOT_SAFETY_PATH: &str = "/etc/default/grub.d/98-orca-boot.cfg";

/// Repair the filesystem at boot (`fsck -y` in the initramfs) instead of
/// stopping for a manual fsck, and make `hvc0` the console, last so that
/// prompts and boot messages go there: Lima records it in `serialv.log`,
/// which System Health shows. Appended to `_DEFAULT`, which comes after the
/// cloud image's `console=tty1 console=ttyAMA0`.
const BOOT_SAFETY_CFG: &str = "# Orca: repair the filesystem at boot instead of waiting at a prompt nobody\n\
# sees, and send boot messages to the console Orca shows (serialv.log).\n\
GRUB_CMDLINE_LINUX_DEFAULT=\"$GRUB_CMDLINE_LINUX_DEFAULT fsck.repair=yes console=hvc0\"\n";

/// Idempotent shell (run as root in the guest) that writes the boot setting
/// and runs `update-grub` only when it changed. Shared by provisioning and
/// the daemon's self-heal, like the other `99-orca-*` settings.
pub fn boot_safety_script() -> String {
    format!(
        "F={BOOT_SAFETY_PATH}\nT=$(mktemp)\ncat > $T <<'ORCA_BOOT_EOF'\n{BOOT_SAFETY_CFG}ORCA_BOOT_EOF\nif ! cmp -s $T $F; then\n  install -m 0644 $T $F\n  update-grub >/dev/null 2>&1 || true\nfi\nrm -f $T\n"
    )
}

/// `~/.lima/<vm>`.
pub fn vm_dir(vm: &str) -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".lima").join(vm)
}

/// The VM's disk image: `disk` (Lima 2), else `diffdisk`.
pub fn disk_path(vm: &str) -> Option<PathBuf> {
    ["disk", "diffdisk"]
        .iter()
        .map(|f| vm_dir(vm).join(f))
        .find(|p| p.is_file())
}

/// The last `lines` lines of the VM's console (`serialv.log` for vz,
/// `serial.log` for QEMU), without terminal escapes. `None` when there's no
/// log; empty when the guest printed nothing.
pub fn console_tail(vm: &str, lines: usize) -> Option<String> {
    let path = ["serialv.log", "serial.log", "serial0.log"]
        .iter()
        .map(|f| vm_dir(vm).join(f))
        .find(|p| p.is_file())?;
    Some(tail_text(&std::fs::read(path).ok()?, lines))
}

/// The last `lines` lines of `bytes`, as text without terminal escapes.
pub fn tail_text(bytes: &[u8], lines: usize) -> String {
    // Only the end matters, and the log can be large.
    let start = bytes.len().saturating_sub(256 * 1024);
    let text = strip_escapes(&String::from_utf8_lossy(&bytes[start..]));
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Drop ANSI escape sequences and carriage returns.
fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI: ESC [ params final-byte; others: ESC + one char.
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                } else {
                    chars.next();
                }
            }
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// A partition of the VM's disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Partition {
    pub number: u32,
    pub name: String,
    /// Byte offset in the disk image.
    pub offset: u64,
    pub size: u64,
}

/// The partitions in a GPT disk image.
pub fn partitions(disk: &Path) -> std::io::Result<Vec<Partition>> {
    use std::io::{Read, Seek, SeekFrom};
    let invalid = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_string());
    let mut f = std::fs::File::open(disk)?;
    let mut header = [0u8; 92];
    f.seek(SeekFrom::Start(512))?;
    f.read_exact(&mut header)?;
    if &header[..8] != b"EFI PART" {
        return Err(invalid("not a GPT disk image"));
    }
    let u64_at = |b: &[u8], i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
    let u32_at = |b: &[u8], i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let (table, count, size) = (u64_at(&header, 72), u32_at(&header, 80), u32_at(&header, 84) as usize);
    if !(128..=4096).contains(&size) || count > 1024 {
        return Err(invalid("unexpected GPT entry layout"));
    }
    f.seek(SeekFrom::Start(table * 512))?;
    let mut out = Vec::new();
    let mut entry = vec![0u8; size];
    for i in 0..count {
        f.read_exact(&mut entry)?;
        if entry[..16].iter().all(|b| *b == 0) {
            continue;
        }
        let (first, last) = (u64_at(&entry, 32), u64_at(&entry, 40));
        let name: Vec<u16> = entry[56..128]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|c| *c != 0)
            .collect();
        out.push(Partition {
            number: i + 1,
            name: String::from_utf16_lossy(&name),
            offset: first * 512,
            size: (last + 1 - first) * 512,
        });
    }
    Ok(out)
}

/// Whether the partition at `offset` holds an ext2/3/4 filesystem.
pub fn is_ext4(disk: &Path, offset: u64) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let mut magic = [0u8; 2];
    std::fs::File::open(disk)
        .and_then(|mut f| {
            f.seek(SeekFrom::Start(offset + 1024 + 56))?;
            f.read_exact(&mut magic)
        })
        .is_ok()
        && magic == [0x53, 0xEF]
}

/// What `write_diagnosis` wrote.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagnosis {
    /// The folder, with README.md and the files it lists.
    pub dir: PathBuf,
    /// What to ask an AI tool started in that folder.
    pub prompt: String,
}

/// Gather what's known about Orca's engine into a new folder under Orca's
/// config dir: logs, the VM's config and console, what runs, free space.
/// Only reads; for a person or an AI tool to start from. `problem` is what
/// the user sees, in a sentence.
pub fn write_diagnosis(problem: &str, orca_version: &str) -> std::io::Result<Diagnosis> {
    let config_dir = crate::config::OrcaConfig::config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let dir = config_dir.join("diagnosis").join(stamp.to_string());
    std::fs::create_dir_all(&dir)?;

    let mut files: Vec<(String, String)> = Vec::new();
    let mut copy_tail = |from: &Path, to: &str, lines: usize, what: &str| {
        if let Ok(bytes) = std::fs::read(from) {
            let _ = std::fs::write(dir.join(to), tail_text(&bytes, lines));
            files.push((to.to_string(), what.to_string()));
        }
    };
    copy_tail(
        &config_dir.join("daemon.log"),
        "daemon.log",
        2000,
        "Orca's daemon, this run",
    );
    copy_tail(
        &config_dir.join("daemon.prev.log"),
        "daemon.prev.log",
        2000,
        "Orca's daemon, the run before",
    );
    let vm = lima_vm();
    if let Some(vm) = &vm {
        let d = vm_dir(vm);
        copy_tail(
            &d.join("ha.stderr.log"),
            "lima-hostagent.log",
            400,
            "Lima's host agent for the VM",
        );
        copy_tail(
            &d.join("serialv.log"),
            "vm-console.log",
            400,
            "The VM's console (empty: it printed nothing)",
        );
        copy_tail(&d.join("lima.yaml"), "lima.yaml", 1000, "The VM's Lima config");
    }

    let run = |program: &str, args: &[&str]| -> String {
        let path = format!(
            "/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin:/sbin:{}",
            std::env::var("PATH").unwrap_or_default()
        );
        match std::process::Command::new(program)
            .env("PATH", path)
            .args(args)
            .output()
        {
            Ok(o) => format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
            Err(e) => format!("(couldn't run {program}: {e})"),
        }
    };
    let mut facts = String::new();
    let mut section = |title: &str, body: String| {
        facts.push_str(&format!("### {title}\n\n```text\n{}\n```\n\n", body.trim_end()));
    };
    section("Orca", format!("Orca Desktop {orca_version}"));
    #[cfg(target_os = "macos")]
    section("macOS", run("sw_vers", &[]));
    section("Free space", run("df", &["-h", "/", "/System/Volumes/Data"]));
    section("Lima VMs", run("limactl", &["list"]));
    section(
        "Orca, Lima and VM processes (CPU time: a VM stuck at boot uses almost none)",
        run("ps", &["-axo", "pid,ppid,lstart,pcpu,time,command"])
            .lines()
            .filter(|l| {
                l.contains("PID")
                    || ["orca-daemon", "limactl", "Virtualization.VirtualMachine"]
                        .iter()
                        .any(|k| l.contains(k))
            })
            .collect::<Vec<_>>()
            .join("\n"),
    );
    section(
        "Daemon health (port 9477)",
        run("curl", &["-s", "-m", "3", "http://127.0.0.1:9477/api/v1/health"]),
    );
    if let Some(vm) = &vm {
        let socket = vm_dir(vm).join("sock/docker.sock");
        section(
            "Docker through the VM's socket",
            run(
                "docker",
                &[
                    "-H",
                    &format!("unix://{}", socket.display()),
                    "info",
                    "--format",
                    "{{.ServerVersion}}",
                ],
            ),
        );
        if let Some(disk) = disk_path(vm) {
            let layout = match partitions(&disk) {
                Ok(parts) => parts
                    .iter()
                    .map(|p| {
                        format!(
                            "{} {:?} offset={} size={} ext4={}",
                            p.number,
                            p.name,
                            p.offset,
                            p.size,
                            is_ext4(&disk, p.offset)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                Err(e) => e.to_string(),
            };
            section(&format!("The VM's disk, {}", disk.display()), layout);
        }
    }

    let vm_name = vm.clone().unwrap_or_else(|| "orca".into());
    let readme = format!(
        "# Orca diagnosis\n\n**The problem:** {problem}\n\n\
Orca Desktop runs Docker in a Lima VM (`{vm_name}`, in `~/.lima/{vm_name}`) on macOS, and its \
daemon (`orca-daemon`, API on 127.0.0.1:9477) talks to Docker through \
`~/.lima/{vm_name}/sock/docker.sock`. System Health in Orca can repair the VM (Repair) and \
check and repair its disk (Rescue).\n\n\
## Files here\n\n{}\n\n## What Orca saw\n\n{facts}\
## Good to know\n\n\
- The VM's console is `~/.lima/{vm_name}/serialv.log`. A VM that's running but whose console is \
empty and whose `com.apple.Virtualization.VirtualMachine` process uses almost no CPU is waiting \
at a prompt early in boot, often a manual fsck after disk errors.\n\
- The VM's disk can be read from macOS while the VM is stopped: `debugfs -c` and \
`e2fsck -f -n` from Homebrew's `e2fsprogs` take `<disk>?offset=<partition offset>`.\n\
- All containers, images and volumes are on that disk. Never delete or recreate the VM, \
and stop it (`limactl stop -f {vm_name}`) before touching its disk.\n",
        files
            .iter()
            .map(|(f, what)| format!("- `{f}`: {what}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    std::fs::write(dir.join("README.md"), readme)?;

    let prompt = format!(
        "Orca Desktop's engine isn't working on my Mac: {problem} Orca gathered what it knows in this \
folder; start with README.md. Find out why, explain it to me, and propose a fix. Ask me before you \
change anything, and never delete or recreate the VM or its disk: it holds all my containers and volumes."
    );
    std::fs::write(dir.join("prompt.txt"), &prompt)?;
    Ok(Diagnosis { dir, prompt })
}

/// Orca's Lima VM: `orca`, else `docker` (what earlier versions made).
pub fn lima_vm() -> Option<String> {
    ["orca", "docker"]
        .iter()
        .find(|vm| vm_dir(vm).join("lima.yaml").is_file())
        .map(|vm| vm.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_tail_without_escapes() {
        let log = b"one\r\n\x1b[0;32m  OK  \x1b[0m two\r\nthree\n";
        assert_eq!(tail_text(log, 2), "  OK   two\nthree");
        assert_eq!(tail_text(b"", 5), "");
    }

    #[test]
    fn boot_safety_appends_to_the_default_cmdline() {
        let s = boot_safety_script();
        assert!(s.contains(BOOT_SAFETY_PATH));
        // Quoted heredoc: the guest's shell must not expand the variable.
        assert!(s.contains("<<'ORCA_BOOT_EOF'"));
        assert!(s.contains("$GRUB_CMDLINE_LINUX_DEFAULT fsck.repair=yes console=hvc0"));
    }

    #[test]
    fn partitions_of_a_gpt_image() {
        let dir = std::env::temp_dir().join(format!("orca-gpt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let disk = dir.join("disk");
        let mut img = vec![0u8; 1024 * 1024 * 3];
        // Header at LBA 1: table at LBA 2, 128 entries of 128 bytes.
        img[512..520].copy_from_slice(b"EFI PART");
        img[512 + 72..512 + 80].copy_from_slice(&2u64.to_le_bytes());
        img[512 + 80..512 + 84].copy_from_slice(&128u32.to_le_bytes());
        img[512 + 84..512 + 88].copy_from_slice(&128u32.to_le_bytes());
        // Entry 1: LBA 2048..4095, "rootfs", with an ext4 superblock.
        let e = 1024;
        img[e..e + 16].copy_from_slice(&[1u8; 16]);
        img[e + 32..e + 40].copy_from_slice(&2048u64.to_le_bytes());
        img[e + 40..e + 48].copy_from_slice(&4095u64.to_le_bytes());
        for (i, c) in "rootfs".encode_utf16().enumerate() {
            img[e + 56 + i * 2..e + 58 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        let sb = 2048 * 512 + 1024 + 56;
        img[sb..sb + 2].copy_from_slice(&[0x53, 0xEF]);
        std::fs::write(&disk, &img).unwrap();

        let parts = partitions(&disk).unwrap();
        assert_eq!(
            parts,
            vec![Partition {
                number: 1,
                name: "rootfs".into(),
                offset: 2048 * 512,
                size: 2048 * 512
            }]
        );
        assert!(is_ext4(&disk, parts[0].offset));
        assert!(!is_ext4(&disk, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_one_rescue_at_a_time() {
        let first = RescueGuard::take();
        assert!(first.is_some() && rescue_running());
        assert!(RescueGuard::take().is_none());
        drop(first);
        assert!(!rescue_running());
    }
}
