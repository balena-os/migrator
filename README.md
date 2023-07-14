# migrator

Command line interface (CLI) to automate migration of a computer to run balenaOS.

**WARNING This tool will overwrite the operating system and all data on the computer that runs it.** Be sure to save any important data before using the migrator.

Migrator accepts a balenaOS image file for your computer, formats it onto the computer's disk/flash storage, collects important configuration data, and then replaces the current operating system with balenaOS derived from that image. As a CLI application, it's easy to automate, and you can run it remotely.

*Our goal is to make it easy to migrate a computer to use balenaOS.* Let us know how it works for you. See the balenaOS [Roadmap](https://balena.fider.io/posts/2/provide-tool-to-onboard-migrate-devices-already-deployed-in-the-field) for planned Migrator features and support for more types of devices. We're also happy to accept code and documentation contributions. See *Development* below.

## Requirements

Migrator requires these features of the computer:

* Currently running Windows 10
* UEFI based firmware
* Ethernet with DHCP (dynamic addressing), *OR*
* WiFi with DHCP, and WPA Personal or open (no) authentication

## Getting Started

### Prepare image
Migrator expects a pre-configured balenaOS flasher image for your device. You only need to perform these download and configure steps once for a fleet.

Use [balenaCLI](https://docs.balena.io/reference/balena-cli/#os-download-type) or the balena [web site](https://www.balena.io/os#download-os) to download the image for your computer. Then configure it for your fleet. If you download from the web site, first unzip the compressed file.
```
  > balena os download generic-amd64 -o balena-flasher.img
     Getting device operating system for generic-amd64
     OS version not specified: using latest released version
     balenaOS image version 2.113.12 downloaded successfully

  > balena os configure balena-flasher.img --fleet MyFleet --version 2.113.12
```

### Analyze computer (optional)
Run the *analyze* command the first time you want to migrate a new device type, or for a computer with a different storage or networking configuration. The analyze command verifies there is sufficient disk storage for the migration, identifies configured WiFi networks, and verifies the balenaCloud API is accessible for registration.

You must run the command below as Administrator on Windows.

```
  > migrator analyze -i balena-flasher.img

FLAGS
  -i, --image=<value>    (required) balenaOS flasher image path name
```

You should see output like below on the CLI from the *analyze* command.
<details>
<summary>Command output</summary>

```
Found WiFi profiles:  quir29key, gal47lows
balena API is reachable from gal47lows (wifi)

Migrate \\.\PhysicalDrive0 with image .\balena-flasher-dev.img

Partitions on target:
index 1, offset 1048576, type C12A7328-F81F-11D2-BA4B-00A0C93EC93B
index 2, offset 105906176, type E3C9E316-0B5C-4DB8-817D-F92DF00215AE
index 3, offset 122683392, type EBD0A0A2-B9E5-4433-87C0-68B6B72699C7
index 4, offset 53129248768, type DE94BBA4-06D1-4D40-A16A-BFD50179D6AC
Boot partition not found on target
Require 42991616 (41.00 MB) for boot partition
RootA partition not found on target
Require 3977248768 (3793.00 MB) for rootA partition
Found 1048576 (1.00 MB) not allocated on disk \\.\PhysicalDrive0

Skip task: shrink partition C by 4020240384 (3834.00 MB)

Skip task: create and copy partitions

Skip task: write configuration

Skip task: bootloader setup
Skip task: reboot
```

</details>


### Run Migrator
The command below prepares the computer for migration, and automatically reboots to execute it and launch balenaOS. You then should see the device appear with its fleet in your balenaCloud dashboard.

Remember the migrator will overwrite all data on the computer! First backup any important data so you can restore it as needed after the migration to balenaOS.

The migrator executes these steps:

1. Run the Analyze step above to ensure balenaCloud is accessible for registration.
2. Shrink disk partitions as needed to ensure enough space to copy the balenaOS image to the disk, and then copy the image.
3. Update the image with system-connections [configuration](https://docs.balena.io/reference/OS/network/#wifi-setup) for all WiFi networks configured on the host computer.
4. Place the bootloader for balenaOS in position, and then automatically reboot the computer to execute the migration.

Download the most recent migrator executable from the Releases [page](https://github.com/balena-os/migrator/releases). The file is named `migrator-v{version}-windows-x64.zip`; unzip it first.

You must run the command below as Administrator on Windows.
```
  > migrator run -i balena-flasher.img [-y]

FLAGS
  -i, --image=<value>    (required) balenaOS flasher image path name
  -y, --non-interactive  no user input; use defaults
```
Since the migrator executes a destructive operation, it first prompts you to confirm. Use the `--non-interactive` option to avoid the prompt and begin the migration immediately.

You should see output like below on the CLI from a successful run of the migrator.
<details>
<summary>Command output</summary>

```
Found WiFi profiles:  quir29key, gal47lows
balena API is reachable from gal47lows (wifi)

Migrate \\.\PhysicalDrive0 with image .\balena-flasher-dev.img

Partitions on target:
index 1, offset 1048576, type C12A7328-F81F-11D2-BA4B-00A0C93EC93B
index 2, offset 105906176, type E3C9E316-0B5C-4DB8-817D-F92DF00215AE
index 3, offset 122683392, type EBD0A0A2-B9E5-4433-87C0-68B6B72699C7
index 4, offset 53129248768, type DE94BBA4-06D1-4D40-A16A-BFD50179D6AC
Boot partition not found on target
Require 42991616 (41.00 MB) for boot partition
RootA partition not found on target
Require 3977248768 (3793.00 MB) for rootA partition
Found 1048576 (1.00 MB) not allocated on disk \\.\PhysicalDrive0
Shrink partition C by 4020240384 (3834.00 MB)

Create flasherBootPartition
Created new partition for boot at offset 49109008384 with size 42991616
Create flasherRootAPartition
Created new partition for data at offset 49152000000 with size 3977248768
Copy flasherBootPartition from image to disk
read: {"position":46137345,"bytes":41943041,"speed":655361128.9081677,"averageSpeed":655360015.625}
write: {"position":41943041,"bytes":41943041,"speed":645276985.799303,"averageSpeed":645277553.8461539}
Copy complete
Copy flasherRootAPartition from image to disk
read: {"position":281018368,"bytes":234881024,"speed":939524096,"averageSpeed":939524096}
write: {"position":232783872,"bytes":232783872,"speed":927426052.665908,"averageSpeed":927425784.8605578}
read: {"position":422576128,"bytes":376438784,"speed":892862464,"averageSpeed":752877568}
write: {"position":375390208,"bytes":375390208,"speed":882800964.0826695,"averageSpeed":749281852.2954092}
...
read: {"position":4022337537,"bytes":3976200193,"speed":692391510.844067,"averageSpeed":700652016.3876652}
write: {"position":3976200193,"bytes":3976200193,"speed":692235395.8367282,"averageSpeed":700281823.3532934}
Copy complete

Write network configuration
Wrote network configuration for quir29key
Wrote network configuration for gal47lows

Mount Windows boot partition and copy grub bootloader from image
Cleared up mount M: for EFI
Copying: /EFI/BOOT/BOOTX64.EFI 	~=>	 M:\EFI\Boot\BOOTX64.EFI
Copying: /EFI/BOOT/GRUB.CFG 	~=>	 M:\EFI\Boot\GRUB.CFG
Copying: /EFI/BOOT/GRUBENV 	~=>	 M:\EFI\Boot\GRUBENV
Copying: /EFI/BOOT/grub_extraenv 	~=>	 M:\EFI\Boot\grub_extraenv
Copied grub bootloader files
Set boot file
Boot file set. The operation completed successfully.

Migration complete, about to reboot
```

</details>


## Development
Migrator provides a command line application to run Etcher SDK's [migrator function](https://github.com/balena-io-modules/etcher-sdk/tree/master/lib/migrator). It uses [oclif](https://oclif.io) and [pkg](https://www.npmjs.com/package/pkg) to provide the command line executable.

To build the migrator, clone this repository, install the node modules and build it as shown below. Like the application itself, presently it builds only on Windows.

```
> git clone https://github.com/balena-os/migrator.git
> cd migrator
> npm install
> npm run build
> del node_modules\pkg\dictionary\drivelist.js
> npm run pkg
```
These commands generate a single-file executable `migrator.exe` in the `dist` directory. You also need to install WiFiProfileManagement [tool](https://github.com/jcwalker/WiFiProfileManagement) in your Powershell module path to run the migrator.

## License
The project is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0).
A copy is also available in the LICENSE file in this repository.

Migrator uses Jason Walker's WiFiProfileManagement Powershell [module](https://github.com/jcwalker/WiFiProfileManagement) to read the Windows WiFi configuration.
