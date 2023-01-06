const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
let drive = undefined;
let file_id_cache = new Map();

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
        try {
                const content = await fs.readFile(TOKEN_PATH);
                const credentials = JSON.parse(content);
                return google.auth.fromJSON(credentials);
        } catch (err) {
                return null;
        }
}

/**
 * Serializes credentials to a file comptible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
        const content = await fs.readFile(CREDENTIALS_PATH);
        const keys = JSON.parse(content);
        const key = keys.installed || keys.web;
        const payload = JSON.stringify({
                type: 'authorized_user',
                client_id: key.client_id,
                client_secret: key.client_secret,
                refresh_token: client.credentials.refresh_token,
        });
        await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
        let client = await loadSavedCredentialsIfExist();
        if (client) {
                return client;
        }
        client = await authenticate({
                scopes: SCOPES,
                keyfilePath: CREDENTIALS_PATH,
        });
        if (client.credentials) {
                await saveCredentials(client);
        }
        return client;
}

/* Returns a list of images
 * TODO: Find folder for recovery_date
 */
async function find_bikes(recovery_date) {
	const drive = await get_drive();
        let next_page_token = "";
        let files = [];
        do {
                const res = await drive.files.list({
                        pageToken: `${next_page_token}`,
                        fields: 'nextPageToken, files(id, name)',
                        q: `'1dcOtZEbt4C05F7EjhqT4aEGRZqJUiNGm' in parents`
                });
                next_page_token = res.data.nextPageToken;
                files = files.concat(res.data.files);
        } while (next_page_token != undefined)

        if (files.length === 0) {
                console.log('No files found.');
        }

        return files.map(bike => ({
		"file_id": bike.id,
		"file_name": bike.name,
		// TODO: we can't really trust that files and with `.jpg`
		"id": bike.name.split(".jpg")[0],
	}));
}

/* TODO: cache image */
async function load_bike_image(image_id, size) {
	const drive = await get_drive();
        const res = await drive.files.get({
                fileId: `${image_id}`,
		fields: 'thumbnailLink',
        });

	let thumbnailLink = res.data.thumbnailLink.split("=")[0];
	if (size != undefined) {
	  const parsed_size = parseInt(size);
	   if (!isNaN(parsed_size) && parsed_size > 0 && parsed_size < 1000) {
             thumbnailLink += `=s${parsed_size}`
	   }
	}

        return thumbnailLink;

}

async function find_file(file_name, is_folder, parent_id) {
	const full_path = (parent_id)?`${parent_id}/${file_name}`:`${file_name}`;

	const cached_id = file_id_cache.get(full_path);
	if (cached_id) {
		console.log("Found cached id for " + full_path);
		return cached_id;
	}

	let next_page_token = "";
	let query = `trashed=false and name='${file_name}'`;

	if (is_folder) {
	       query += "and mimeType='application/vnd.google-apps.folder'";
	}

	if (parent_id != undefined) {
 		query += `and '${parent_id}' in parents`;
	}

	do {
		let result = await drive.files.list({
			pageToken: `${next_page_token}`,
			q: query,
			fields: 'nextPageToken, files(id, name)',
		});
		let file = result.data.files.filter(x => x.name === file_name);
		if (file.length > 0) {
			file_id_cache.set(full_path, file[0].id);
			return file[0].id;
		}

		next_page_token = result.data.nextPageToken;
	} while (next_page_token != undefined)

	return undefined;
}

async function find_or_create_main_folder() {
	const drive = await get_drive();
	const folder = "bike_recovery_data";

	const main_folder_id = await find_file(folder, true);

	if (main_folder_id != undefined) {
		console.log("Found main folder");
		return main_folder_id;
	}

	const fileMetadata = {
		name: folder,
		mimeType: 'application/vnd.google-apps.folder',
	};

	const file = await drive.files.create({
		resource: fileMetadata,
		fields: 'id',
	});

	console.log("New main folder was created");

	return file.data.id
}

async function find_or_create_recovery_date_folder(recovery_date) {
	const drive = await get_drive();
	const main_folder = await find_or_create_main_folder();

	const recovery_date_folder_id = await find_file(recovery_date, true, main_folder);

	if (recovery_date_folder_id != undefined) {
		console.log("Found recovery_date folder");
		return recovery_date_folder_id;
	}

	const fileMetadata = {
		name: recovery_date,
		mimeType: 'application/vnd.google-apps.folder',
		parents: [main_folder],
	};

	const file = await drive.files.create({
		resource: fileMetadata,
		fields: 'id',
	});

	console.log("New recovery_date folder was created");

	return file.data.id
}

async function store_bike_preference(association, recovery_date, preferences) { 
	const drive = await get_drive();
	const file_name = `${association}-${recovery_date}.json`;
	const recovery_date_folder = await find_or_create_recovery_date_folder(recovery_date);

	const old_file_id = await find_file(file_name, false, recovery_date_folder);

	if (old_file_id != undefined) {
		console.log("preference already submitted");
		return false;
	}

	const fileMetadata = {
		name: file_name,
		parents: [recovery_date_folder],
	};

	const media = {
		mimeType: 'application/json',
		body: JSON.stringify(preferences),
	};
	const file = await drive.files.create({
		resource: fileMetadata,
		media: media,
		fields: 'id',
	});

	console.log('File Id of stored preferences:', file.data.id);
	return true;
}

async function load_bike_preference(association, recovery_date) { 
	const drive = await get_drive();
	const file_name = `${association}-${recovery_date}.json`;
	// It's fine to create the main folder since it will be used sooner or later
	const main_folder = await find_or_create_main_folder();
	// We don't want to create the recovery folder if it doesn't exsits yet
	const recovery_date_folder_id = await find_file(recovery_date, true, main_folder);
	const file_id = await find_file(file_name, false, recovery_date_folder_id);

	if (file_id === undefined) {
		console.log("No preference was submitted for this date");
		return;
	}

	const file = await drive.files.get({
		fileId: file_id,
		alt: 'media',
	});
	return file.data;
}

async function store_assigned_bikes(assignment, recovery_date) { 
	const drive = await get_drive();
	const file_name = `assigned-bikes-${recovery_date}.json`;
	const recovery_date_folder = await find_or_create_recovery_date_folder(recovery_date);

	const old_file_id = await find_file(file_name, false, recovery_date_folder);

	if (old_file_id != undefined) {
		console.log("assignment already submitted for recovery_date " + recovery_date);
		return false;
	}

	const fileMetadata = {
		name: file_name,
		parents: [recovery_date_folder],
	};

	const media = {
		mimeType: 'application/json',
		body: JSON.stringify(assignment),
	};
	const file = await drive.files.create({
		resource: fileMetadata,
		media: media,
		fields: 'id',
	});

	console.log('File Id of stored assigments:', file.data.id);
	return true;
}

async function load_assigned_bikes(recovery_date) { 
	const drive = await get_drive();
	const file_name = `assigned-bikes-${recovery_date}.json`;
	// It's fine to create the main folder since it will be used sooner or later
	const main_folder = await find_or_create_main_folder();
	// We don't want to create the recovery folder if it doesn't exsits yet
	const recovery_date_folder_id = await find_file(recovery_date, true, main_folder);
	const file_id = await find_file(file_name, false, recovery_date_folder_id);

	if (file_id === undefined) {
		console.log("No assigment was stored for recovery date " + recovery_date);
		return;
	}

	const file = await drive.files.get({
		fileId: file_id,
		alt: 'media',
	});
	return file.data;
}


async function store_association_points(points) { 
	const drive = await get_drive();
	const file_name = `points.json`;
	const main_folder = await find_or_create_main_folder();

	const old_file_id = await find_file(file_name, false, main_folder);

	const media = {
		mimeType: 'application/json',
		body: JSON.stringify(points),
	};
	console.log(media)


	if (old_file_id != undefined) {
		const old_file = await drive.files.update({
			fileId: old_file_id,
			media: media,
			fields: 'id',
		});

		if (old_file_id != old_file.data.id) {
			console.log("Updating a file changes it's id");
			// TOOD: delete id cache
		}


		console.log('File Id of stored points after updating:', old_file.data.id);
	} else {

		const fileMetadata = {
			name: file_name,
			parents: [main_folder],
		};

		const file = await drive.files.create({
			resource: fileMetadata,
			media: media,
			fields: 'id',
		});

		console.log('File Id of stored points:', file.data.id);
	}

	return true;
}

async function load_association_points() { 
	const drive = await get_drive();
	const file_name = `points.json`;
	// It's fine to create the main folder since it will be used sooner or later
	const main_folder = await find_or_create_main_folder();
	const file_id = await find_file(file_name, false, main_folder);

	if (file_id === undefined) {
		console.log("No points where stored so far");
		return {};
	}

	const file = await drive.files.get({
		fileId: file_id,
		alt: 'media',
	});
	return file.data;
}


async function get_drive() {
	if (drive === undefined) {
		const authClient = await authorize();
		drive = google.drive({version: 'v3', auth: authClient});
	}

	return drive;
}

async function get_request() {
	const authClient = await authorize();
	const requesst = google.request({version: 'v3', auth: authClient});
	return request;
}


module.exports = { load_bike_image, find_bikes, store_bike_preference, load_bike_preference, store_assigned_bikes, load_assigned_bikes, store_association_points, load_association_points};
