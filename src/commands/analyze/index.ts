import { Flags } from '@oclif/core';
// Must use CommonJS version of inquirer due to limitations of vercel/pkg.
import * as inquirer from 'inquirer';
import { migrator } from 'etcher-sdk';
import { Analyzer, ConnectionProfile } from '../../lib/networking-analyzer'
import { MigratorCommand } from '../../lib/migrator-command'

export default class AnalyzerCommand extends MigratorCommand {
	static description = 'Analyze migration of this device to balenaOS';

	static examples = [
		'migrator analyze -i \\Users\\John\\balena-flasher.img',
	];

	static flags = {
		image: Flags.string({
			char: 'i',
			required: true,
			description: "balenaOS image path name",
		}),
		'no-wifi': Flags.boolean({
			default: false,
			description: "do not analyze WiFi network configurations"
		}),
	};
	static args = {};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(AnalyzerCommand)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		const skipTasks = 'shrink,copy,config,bootloader,reboot'
		const options:migrator.MigrateOptions = { omitTasks: skipTasks, connectionProfiles: []}

		let resOK = true
		try {
			// Run networking analyzer to collect profiles and validate connectivity.
			const psInstallPath = `${process.cwd()}\\modules`
			const analyzerOptions = { includeWifi: !flags['no-wifi'] }
			const analyzer = new Analyzer(psInstallPath, analyzerOptions)
			await analyzer.run()

			const profiles = await this.validateAnalyzer(analyzer)
			profiles.forEach(p => options.connectionProfiles.push(p))

			//console.log(`${flags.image}, ${winPartition}, ${deviceName}, ${efiLabel}, ${options.omitTasks}`)
			const res = await migrator.migrate(flags.image, winPartition, deviceName, efiLabel, options)
			resOK = (res == migrator.MigrateResult.OK) 
		} catch (error) {
			console.log("Can't proceed with migration:", error);
			resOK = false
		}
		this.exit(resOK ? 0 : 1)
	}
}
