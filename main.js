const http = require("http");
const fs = require('fs');
const config = require('config');
const url_parser = require('url');
const drive = require("./drive");
const querystring = require('querystring');
const crypto = require('crypto');
const moment = require('moment');
const Mutex = require('async-mutex').Mutex;

const host = 'localhost';
const port = 8000;

const exclusive_operation = new Mutex();

const association_list = config.get("association_list");

function valid_redirection(path) {
	switch (path) {
		case "/":
		case "/add-recovery-date":
		case "/add-recovery-date-submitted":
		case "/select-recovery-date":
		case "/select-bike-preference":
		case "/bike-preference-submitted":
		case "/assigned-bikes":
		case "/add-recovery-date":
		case "/bike":
			return true;
		default: 
			return false;
	}
}

let token_store = new Map();

function parseCookies(request) {
	const list = {};
	const cookieHeader = request.headers?.cookie;
	if (!cookieHeader) return list;

	cookieHeader.split(`;`).forEach(function(cookie) {
		let [ name, ...rest] = cookie.split(`=`);
		name = name?.trim();
		if (!name) return;
		const value = rest.join(`=`).trim();
		if (!value) return;
		list[name] = decodeURIComponent(value);
	});

	return list;
}

function get_association(request) {
	const token = parseCookies(request)?.token;

	if (token) {
		return token_store.get(token);
	}
}


const requestListener = async function (req, res) {
	try {
	let url = url_parser.parse(req.url, true);

	const association = get_association(req);
	const token = parseCookies(req)?.token;
	if (!association) {
		switch (url.pathname) {
			case "/":
				if (req.method === 'POST') {
					let body = await get_post_data(req);
					const input = querystring.parse(body);

					let valid_ass = undefined;
					for (const ass of association_list) {
						if (ass.id === input["association"] && ass.password === crypto.createHash('sha256').update(input["password"]).digest('base64')) {
							valid_ass = ass.id;
						}
					}

					if (valid_ass) {
						console.log("Logged In as " + valid_ass);
						const token = crypto.randomBytes(64).toString('hex');

						token_store.set(token, valid_ass);

						var redirect_url = url.query["redirect"] ?? "/select-recovery-date";
						res.writeHead(303, {
							'Location': decodeURIComponent(redirect_url),
							'Set-Cookie': `token=${token}; HttpOnly`,
						});

						res.end('ok');
					} else {
						res.setHeader("Content-Type", "text/html; charset=utf-8");
						res.statusCode = 200;
						res.end(await create_login_page("La password inserita non e' valida. Assicurati che hai scelto l' associazione giusta e hai inserito la password corretta"));
					}
				} else {
					var redirect_url = url.query["redirect"];
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.statusCode = 200;
					if (redirect_url) {
						res.end(await create_login_page("E' necessario effeturare il login per proseguire"));
					} else {
						res.end(await create_login_page());
					}
				}
				break
			default:
				if (valid_redirection(url.pathname)) {
					let path = "";
					// We need to make sure that we don't encode the password in the url therefore don't allow "/"
					if (req.method === 'POST' && url.pathname != "/") {
						let post_data = Buffer.from(await get_post_data(req)).toString('base64');
						path = `${url.path}&data=${post_data}`;
					} else {
						path = url.path;
					}
					res.writeHead(303, {
						'Location': `/?redirect=${encodeURIComponent(path)}`,
						'Set-Cookie': 'token=; expires=Thu, Jan 01 1970 00:00:00 UTC',
					});
					res.end('ok');
				} else if (url.pathname === "/logoff") {
					res.writeHead(303, {
						'Location': '/',
						'Set-Cookie': 'token=; expires=Thu, Jan 01 1970 00:00:00 UTC',
					});
					res.end('ok');
				} else {
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.writeHead(404);
					res.end(create_error_page(404));
				}
		}
	} else {
		switch (url.pathname) {
			case "/":
				res.writeHead(303, {
					'Location': '/select-recovery-date',
				});
				res.end('ok');
				break
			case "/logoff":
				if (token) {
					token_store.set(token, undefined);
				}

				res.writeHead(303, {
					'Location': "/",
					'Set-Cookie': 'token=; expires=Thu, Jan 01 1970 00:00:00 UTC',
				});
				res.end('ok');
				break
			case "/add-recovery-date":
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 200;
				res.end(await create_add_recovery_date_page());
				break
			case "/add-recovery-date-submitted":
				var recovery_date = url.query.recovery_date;
				var drive_url = url.query.recovery_images_url;

				if (!is_valid_recovery_date(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 200;
				res.end(await create_add_recovery_date_submitted_page(recovery_date, drive_url));
				break
			case "/select-recovery-date":
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 200;
				res.end(await create_select_recovery_date_page());
				break
			case "/select-bike-preference":
				var recovery_date = url.query.recovery_date;

				if (!is_valid_recovery_date(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				if (is_recovery_deadline_past(recovery_date)) {
					res.writeHead(303, {
						'Location': `/assigned-bikes?recovery_date=${recovery_date}`,
					});
					res.end('ok');
					return;
				}

				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 200;
				res.end(await create_select_bike_preference_page(association, recovery_date));
				break
			case "/bike-preference-submitted":
				var recovery_date = url.query.recovery_date;
				if (!is_valid_recovery_date(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				if (is_recovery_deadline_past(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				var data = url.query["data"];
				if (data) {
					data = Buffer.from(data, 'base64').toString('ascii');
				} else if (req.method === 'GET') {
					invalid_request_data(res);
					return;
				}

				if (req.method === 'POST' || (req.method === 'GET' && data)) {
					// Use url query data if it's a get request
					let body = req.method === 'GET'? data : await get_post_data(req);
					const input = querystring.parse(body);
					let preferences = {};
					for (const bike in input) {
						if (bike === "number_of_needed_bikes") {
						}
						const parsed_value = parseInt(input[bike]);
						if (!isNaN(parsed_value) && ((parsed_value >= 0 && parsed_value <= 3) || bike === "number_of_needed_bikes")) {
							preferences[bike] = parsed_value;
						} else {
							console.log("Not a valid preference for this bike: " + bike);

							invalid_request_data(res);
							return;
						}
					}

					console.log(`Store preferences for ${association}`);
					await drive.store_bike_preference(association, recovery_date, preferences);

					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.statusCode = 200;
					res.end(create_bike_preference_submitted_page(recovery_date));
				} else {
					invalid_request_data(res);
					return;
				}
				break
			case "/assigned-bikes":
				var recovery_date = url.query.recovery_date;
				if (!is_valid_recovery_date(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				if (!is_recovery_deadline_past(recovery_date)) {
					invalid_request_data(res);
					return;
				}

				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 200;
				res.end(await create_assigned_bikes_page(recovery_date, association));
				break
			case "/bike":
				const bike_id = url.query.bike_id;
				const size = url.query.size;
				// TODO: offer the images directly without redirect, because loading the thumbnail may fail, looks like it works now
				let image_url = await drive.load_bike_image(bike_id, size);
				res.writeHead(307, {
					'Location': image_url,
				});
				res.end();
				break;
			default:
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.statusCode = 404;
				res.end(create_error_page(404));
		}
	}
	} catch(error) {
		console.log(error);
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.writeHead(500);

		let context = {url: req.url, headers: req.headers};
		res.end(create_error_page(500, JSON.stringify(context,  null, 2) + "\n\n" + error.stack));
	}
}

const server = http.createServer(requestListener);
server.listen(port, host, () => {
	console.log(`Server is running on http://${host}:${port}`);
});

function create_error_page(status_code, error) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>"
	);

	switch (status_code) {
		case 400:
			html.push(
				"<h2>Richiesta non valida</h2>",
				"<h4>La richesta inviata non e' consentito oppure non e' valida</h4>",
			)
			break;
		case 404:
			html.push(
				"<h2>Pagina non trovato</h2>",
				"<h4>Hai raggiunto una pagina che non esiste</h4>",
			)
			break;
		default:
			html.push(
				"<h2>Errore interno del server</h2>",
				"<h4>Il server ha trovato un problema ed non e' riuscito effeturare l' operazione richiesta</h4>",
				`Scrivi un email all' administratore <a href='mailto:julian@efesta.net'>Julian</a> con il seguente message di errore`
			)
			break;
	}

	if (error != undefined) {
		html.push(
			"<br>",
			"<br>",
			'<div style="display: inline-block;text-align: left;">',
			`<pre><code>${error}</code></pre>`,
			"</div>",
			"<br>",
		);
	}

	html.push(
		"</br>",
		"Puoi tornare alla pagina pricinpale oppure disconnetterti e ripropvare di effetuare il login",
	);

	html.push(
		"<div>",
		'<a href="/" style="margin-right: 10px;">',
		'<button type="button">Torna alla pagina principale</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}


function create_login_page(error) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
		"<h2>Piattaforma per il patto di collaborazione per il recupero bici</h2>",
		"<h4>Per quale associazione intendi a selezionoare le bici</h4>",
	);

	html.push(
		'<form method="post">',
		'<div style="display: inline-block;text-align: left;">',
	);

	for (const association of association_list) {
		html.push(
			'<div>',
			`<input type="radio" id="selection_${association.id}" name="association" value="${association.id}">`,
			`<label for="selection_${association.id}">${association.name}</label>`,
			'</div>',
		);
	}

	html.push(
		'</div>',
		'<div>',
		'<br>',
		'<label for="password_entry" style="margin-right: 10px;">Password:</label>',
		'<input id="password_entry" type="password" name="password" />',
		'</div>',
		'<br>',
	);

	if (error) {
		html.push(
			`<div style="color: red;">${error}</div>`
		);
	}

	html.push(
		'<input type="submit" value="Accedi" />',
		'</form>',
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}

async function create_add_recovery_date_page() {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		"<div>",
		'<a href="/" style="margin-right: 10px;">',
		'<button type="button">Torna alla pagina principale</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		"<h2>Aggiungi let foto e la data per il nuovo ritiro</h2>",
	);

	// Automaticaly select the next Wednesday since it should always be a Wednesday
	var d = new Date()
	d.setDate(d.getDate() + (((3 + 7 - d.getDay()) % 7) || 7));
	var probably_next_date = `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	html.push(
		'<form action="/add-recovery-date-submitted" method="get">',
		'<div>',
		'<label>Data del ritiro: ',
		`<input type="date" name="recovery_date" value="${probably_next_date}" required />`,
		'</label>',
		'</div>',
		'<div>',
		'<label>Link della cartella delle foto: ',
		'<input type="url" name="recovery_images_url" value="" required />',
		'</label>',
		'</div>',
		'<br>',
		'<div>',
		'<input type="submit" value="Aggiungi data" />',
		'</div>',
		'</form>',
	);

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}

async function create_add_recovery_date_submitted_page(recovery_date, drive_url) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		"<div>",
		'<a href="/" style="margin-right: 10px;">',
		'<button type="button">Torna alla pagina principale</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	await drive.add_recovery_metadata(recovery_date, drive_url);
	// TODO: Check if we find anything for it
	let bikes = await drive.find_bikes(recovery_date);

	html.push(
		`<h2>Nuovo ritiro aggiunto per il ${recovery_date}</h2>`,
		"<h3>Grazie per avere aggiunto la data e le foto di un nuovo ritiro</h3>",
	);

	html.push(
		"<div>",
		'<a href="/select-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Torna alla selezione della data di ritiro</button>',
		'</a>',
		`<a href="/select-bike-preference?recovery_date=${recovery_date}" style="margin-right: 10px;">`,
		'<button type="button">Invia preference per questo ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");

}

async function create_select_recovery_date_page() {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		"<div>",
		'<a href="/add-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Aggiungi nuovo ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		"<h2>Scelgi le la data del ritiro</h2>",
		"<h5>Se un ritiro non e' presente nella lista lo puoi aggiungire con il pulsante sopra</h5>",
	);

	html.push(
		"<h3>Prossimo ritiro</h3>",
	);

	const dates = (await drive.find_recovery_dates()).map(date => {return date.date;});
	console.log(dates);
	let past_dates = [];

	for (const date of dates) {
		if (is_past_recovery(date)) {
			past_dates.push(date);
			continue;
		}

		html.push(
			'<div style="margin-bottom: 10px;">',
			`<a href="/select-bike-preference?recovery_date=${date}" style="margin-right: 10px;">`,
			`<button type="button">${date}</button>`,
			'</a>',
			"</div>",
		);
	}

	if (past_dates.length > 0 ) {
		html.push(
			"<h3>Ritiri passati</h3>",
		);

		for (const date of past_dates) {
			html.push(
				'<div style="margin-bottom: 10px;">',
				`<a href="/assigned-bikes?recovery_date=${date}" style="margin-right: 10px;">`,
				`<button type="button">${date}</button>`,
				'</a>',
				"</div>",
			);
		}
	}

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}


async function create_select_bike_preference_page(association, recovery_date) {
	let was_already_submitted = await drive.bike_preference_submitted(association, recovery_date);

	if (was_already_submitted) {
		return create_already_submitted_page(recovery_date);
	}

	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
	);

	html.push(`<script>
	function update_preference_count(self) {
		// The order is not interessted, little interessted, interessted, interssted a lot 
		let selection_count = [0, 0, 0, 0];

		for (let input of self) {
			if (input.type != "radio" || !input.checked) {
				continue;
			}
			selection_count[input.value]++;
		}
		let selected_bikes_message = document.getElementById("selected_bikes_message"); 
		let total_bikes = selection_count[0] + selection_count[1] + selection_count[2] + selection_count[3];
		let total_selected_bikes = selection_count[1] + selection_count[2] + selection_count[3];

		selected_bikes_message.innerHTML = "Hai scelto in totale " + total_selected_bikes + 
		" bici di <b>" + total_bikes + "</b>, di cui ti interssano molto <b>" + selection_count[3] + 
		"</b>, ti interssano <b>" + selection_count[2] + 
		"</b> e ti intersssano poco <b>" + selection_count[1] + "</b>";

		const number_of_needed_bikes = document.getElementById("number_of_needed_bikes");
		number_of_needed_bikes.value = selection_count[3];
	}
	</script>`);



	html.push(
		"<center>",
		"<div>",
		'<a href="/select-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Torna alla selezione della data di ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		`<h2>Invia preference per il ritirare del ${recovery_date}</h2>`,
		"Sotto puoi esprimere la tua preference delle bici che vorresti ritirare.",
		"<br>",
		"In piu' puoi indicare il nummero massimo di bici che vorresti ottenere.",
		"<br>",
		'E\' consigliato di indicare <b>Mi interessa molto</b> per alemeno il nummero di bici che vorresti,',
		"<br>",
		'perche\' una bici viene assegnato prima all\' associazione che ha espresso il maggiore interesse.',
		`<form action="/bike-preference-submitted?recovery_date=${recovery_date}" method="post">`,
	);

	let bikes = await drive.find_bikes(recovery_date);

	for (const bike of bikes) {
		html.push(
			"<div>",
			`<h3>Bici: ${bike.id} </h3>`,
			`<img src="/bike?bike_id=${bike.file_id}&size=800" alt="${bike.file_name}">`,
			'<div>',
			`<input type="radio" id="selection_3_${bike.id}" name="${bike.id}" oninput="update_preference_count(this.form)" value="3">`,
			`<label for="selection_3_${bike.id}">Mi interessa molto</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_2_${bike.id}" name="${bike.id}" oninput="update_preference_count(this.form)" value="2">`,
			`<label for="selection_2_${bike.id}">Mi interessa</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_1_${bike.id}" name="${bike.id}" oninput="update_preference_count(this.form)" value="1">`,
			`<label for="selection_1_${bike.id}">Mi interessa poco</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_0_${bike.id}" name="${bike.id}" oninput="update_preference_count(this.form)" value="0" checked="checked">`,
			`<label for="selection_0_${bike.id}">Non mi interessa</label>`,
			'</div>',
			"</div>",
			"<hr>",
		)
	}

	html.push(
		'<br>',
		'<div id="selected_bikes_message">',
		"Hai scelto nessuna bici che ti interessa.",
		'</div>',
		'<br>',
		'<div>',
		`<label for="number_of_needed_bikes">Il nummero di bici che vorresti:</label>`,
		'<br>',
		`<input type="number" id="number_of_needed_bikes" name="number_of_needed_bikes" max=${bikes.length} min=0></input>`,
		'</div>',
		'<br>',
		'<input type="submit" value="Invia scelte" />',
		'</form>',
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}

function create_bike_preference_submitted_page(recovery_date) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		`<h2>La tua preferenza per il ritiro ${recovery_date} e' stata inviata</h2>`,
		"<h3>Grazie per avere inviato la preferenzs delle bici per la tua assocazione</h3>",
	);

	html.push(
		"<div>",
		'<a href="/select-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Torna alla selezione della data di ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	return html.join("");
}

function create_already_submitted_page(recovery_date) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		`<h2>Hai gia invitato la tua preferenza per il ritiro ${recovery_date}</h2>`,
		"<h3>La lista delle bici da ritirare sara disponibile da mezza notte del giorno precedente al ritirito</h3>",
	);

	html.push(
		"<div>",
		'<a href="/select-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Torna alla selezione della data di ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	return html.join("");
}

async function create_assigned_bikes_page(recovery_date, association) {
	let bikes = await drive.load_assigned_bikes(recovery_date);

	if (bikes === undefined) {
		const release = await exclusive_operation.acquire();
		try {
			await calculate_assigned_bikes(recovery_date);
		} finally { 
			release();
		}
		bikes = await drive.load_assigned_bikes(recovery_date);
	} 

	let my_bikes = bikes.filter(bike => bike.association === association);
	let unassigned_bikes = bikes.filter(bike => bike.association === undefined);

	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
	);

	html.push(
		"<div>",
		'<a href="/select-recovery-date" style="margin-right: 10px;">',
		'<button type="button">Torna alla selezione della data di ritiro</button>',
		'</a>',
		'<a href="/logoff">',
		'<button type="button">Disconnetti</button>',
		'</a>',
		"</div>",
	);

	html.push(
		`<h2>Pottrai ritira le seguente bici il ${recovery_date}</h2>`,
		"<h4>In fondo trovate tutte le bici non assegnate</h4>",
		"<div>",
		`A tua associazione sono state assegnato ${my_bikes.length} bici delle  ${bikes.length} bici di questo ritiro. Invece ${unassigned_bikes.length} bici non sono state assegnato a una assocazione.`,
		"</div>",
	);

	for (const bike of my_bikes) {
		html.push(
			"<div>",
			`<h3>Bici: ${bike.id}</h3>`,
			`<img src="/bike?bike_id=${bike.file_id}&size=800" alt="${bike.file_name}">`,
			"</div>",
			"<hr>",
		)
	}

	if (unassigned_bikes.length > 0) {
		html.push(
			"<h2>Bici non assegnate</h2>",
			"<h4>Queste bici non sono state scelte da nessuna associazione</h4>",
		)

		for (const bike of unassigned_bikes) {
			html.push(
				"<div>",
				`<h3>Bici: ${bike.id}</h3>`,
				`<img src="/bike?bike_id=${bike.file_id}&size=800" alt="${bike.file_name}">`,
				"</div>",
				"<hr>",
			)
		}
	}

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}

// Taken from https://stackoverflow.com/a/6274381
function shuffle(a) {
	var j, x, i;
	for (i = a.length - 1; i > 0; i--) {
		j = Math.floor(Math.random() * (i + 1));
		x = a[i];
		a[i] = a[j];
		a[j] = x;
	}
	return a;
}


async function calculate_assigned_bikes(recovery_date) {
	let points = await drive.load_association_points();
	let no_selected_bikes = {};
	let preference_list = {};
	let bikes = await drive.find_bikes(recovery_date);
	let assigned_bikes = [];
	for (const association of association_list) {
		preference_list[association.id] = await drive.load_bike_preference(association.id, recovery_date);
		if (points[association.id] === undefined) {
			points[association.id] = 0;
		}
	}

	console.log("Load assigment bikes");
	console.log("Start list of bikes:");
	console.log(bikes);
	console.log("Start points:")
	console.log(points);

	let number_assigned_bikes = [];
	for (const association of association_list) {
		number_assigned_bikes[association.id] = 0;
		if (preference_list[association.id] === undefined) {
			continue;
		}
		console.log(preference_list[association.id]);
		if (preference_list[association.id].number_of_needed_bikes === undefined) {
			preference_list[association.id].number_of_needed_bikes = bikes.length;
		}
	}

	for (const priority of [3, 2, 1]) {
		// Find assosations intressted in a specific bike assining bikes without conflicts directly
		let interested = {};
		for (var bike of bikes) {
			let interest_for_bike = [];
			// Skip over already assigned bikes
			if (bike.association !== undefined) {
				continue;
			}
			for (const association of association_list) {
				if (preference_list[association.id] === undefined) {
					continue;
				}
				if (preference_list[association.id][bike.id] === undefined) {
					continue;
				}
				if (preference_list[association.id][bike.id] == priority) {
					interest_for_bike.push(association.id);
				}
			}

			// Ignore bikes nobody is interessted in
			if (interest_for_bike.length === 0) {
				// If there is only one association interessted assign it direclty
			} else if (interest_for_bike.length === 1) {
				const ass = interest_for_bike[0];
				if (number_assigned_bikes[ass] < preference_list[ass].number_of_needed_bikes) {
					bike["association"] = ass;
					number_assigned_bikes[ass]++;
				}
			} else {
				interested[bike.id] = interest_for_bike; 
			}
		}

		// Resolve conflicts 
		for (var bike of shuffle(bikes)) {
			// Skip over already assigned bikes
			if (bike.association !== undefined) {
				continue;
			}

			// Skip over bikes nobody is interessted in at this priority level
			if (interested[bike.id] === undefined) {
				continue;
			}

			let ass_with_max_points;

			for (const ass of interested[bike.id]) {
				// Once a assosation has recived enough bikes don't assign any bikes any more
				if (number_assigned_bikes[ass] >= preference_list[ass].number_of_needed_bikes) {
					continue;
				}

				if (ass_with_max_points === undefined) {
					ass_with_max_points = ass;
				} else if (points[ass] === points[ass_with_max_points]) {
					// Select at random which association should recive the bike
					if (Math.floor(Math.random() * 2) === 0) {
						ass_with_max_points = ass;
					}
				} else if (points[ass] > points[ass_with_max_points]) {
					ass_with_max_points = ass;
				}
			}

			// Only change points if there where conflicts
			if (interested[bike.id].filter(ass => number_assigned_bikes[ass] < preference_list[ass].number_of_needed_bikes).length > 1) {
				for (const ass of interested[bike.id]) {
					if (ass_with_max_points == ass) {
						points[ass] -= priority
					} else {
						points[ass] += priority / interested[bike.id].length
					}
				}
			}

			bike["association"] = ass_with_max_points;
			number_assigned_bikes[bike["association"]]++;

		}
	}
	console.log("Store assigment bikes");
	console.log("Final list of assinged bikes:");
	console.log(bikes);
	console.log("Final points:")
	console.log(points);
	await drive.store_assigned_bikes(bikes, recovery_date);
	await drive.store_association_points(points);
}

async function get_post_data(req) {
	let p = new Promise((resolve, reject) => {
		let body = '';

		req.on('data', (chunk) => {
			body += chunk.toString();
		});

		req.on('end', () => {
			resolve(body);
		});

		req.on('error', (err) => {
			reject(err);
		});
	});

	return await p;
}

function is_valid_recovery_date(recovery_date) {
	return moment(recovery_date, "YYYY-MM-DD", true).isValid();
}

function is_past_recovery(recovery_date) {
	const today = new Date();
	return ((new Date(recovery_date)) < today)
}

function is_recovery_deadline_past(recovery_date) {
	const date = new Date(recovery_date);
	date.setHours(0,0,0,0);
	date.setDate(date.getDate() - 1);
	const now = new Date();
	return (now > date)
}

function invalid_request_data(res) {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.writeHead(400);
	res.end(create_error_page(400));
}

/* TODOS:
- [x] Autentication, identification for different assosciations
- [x] Allow to login
- [x] Find folder for "tornate", maybe allow to add a new recovery via pasting link
- [x] Load photos from google drive
- [x] Display images and allow setting preferences via html page
- [x] Store preferences
- [x] Load preferences
- [x] Calculate assigned bikes and calculate remaining points
- [x] Show assigned bikes via html page
- [x] Cache folder and file ids, they don't change
- [x] show assigned bikes with information when they will show up
- [x] Store and load points from file 
- [x] Store and load assigned bikes
- [x] show request errors
- [x] show internal errors
- [x] validated GET DATA, mostly recovery date
- [x] Make sure that the preference selection isn't lost when the token expires and still send and stored
- [x] Show nummber of selected bikes per preference at the end of bike selection

Nice to have
- [ ] Allow to delete selection before deadline
- [ ] Maintain selection between page loads and logins
- [ ] Invalidate tokens after some time
- [ ] Remove token from token_store after some time
- [ ] Don't show internel server error when the requested recovery date doesn't exsit
- [ ] List selected bikes on confirmation page and number of selected bikes per preference
- [ ] Show bikes selected by other assosations on assigned bike page, or/and all bikes 

*/

