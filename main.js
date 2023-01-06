const http = require("http");
const url_parser = require('url');
const drive = require("./drive");
const querystring = require('querystring');
const crypto = require('crypto');

const host = 'localhost';
const port = 8000;


const association_list = [
	{
		id: "piazza_grande",
		name: "Piazza Grande",
		password: "",
	},
	{
		id: "csapsa",
		name: "Csapsa s.c.r.l.",
		password: "",
	},
	{
		id: "altra_babele",
		name: "L’Altra Babele",
		password: "",
	},
	{
		id: "chiusi_fuori",
		name: "Chiusi Fuori",
		password: "",
	},
	{
		id: "efesta",
		name: "Efesta APS",
		password: "",
	}
];

function valid_redirection(path) {
	switch (path) {
		case "/":
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
						if (ass.id === input["association"] && ass.password === input["password"]) {
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
						res.writeHead(200);
						res.end(await create_login_page("La password inserita non e' valida. Assicurati che hai scelto l' associazione giusta e hai inserito la password corretta"));
					}
				} else {
					var redirect_url = url.query["redirect"];
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.writeHead(200);
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
					res.end(await create_error_page());
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
				res.writeHead(200);
				res.end(await create_add_recovery_date_page());
				break
			case "/select-recovery-date":
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.writeHead(200);
				res.end(await create_select_recovery_date_page());
				break
			case "/select-bike-preference":
				var recovery_date = url.query.recovery_date;

				if (is_past_recovery(recovery_date)) {
					res.writeHead(303, {
						'Location': `/assigned-bikes?recovery_date=${recovery_date}`,
					});
					res.end('ok');
					return;
				}

				// TODO: show error if we don't have a valid recovery_date
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.writeHead(200);
				res.end(await create_select_bike_preference_page(recovery_date));
				break
			case "/bike-preference-submitted":
				var recovery_date = url.query.recovery_date;
				// TODO: show error if we don't have a valid recovery_date

				var data = url.query["data"];
				if (data) {
					data = Buffer.from(data, 'base64').toString('ascii');
				} else if (req.method === 'GET') {
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.writeHead(404);
					res.end(await create_error_page("Selezione di bici non valida"));
					return;
				}

				if (req.method === 'POST' || (req.method === 'GET' && data)) {
					// Use url query data if it's a get request
					let body = req.method === 'GET'? data : await get_post_data(req);
					const input = querystring.parse(body);
					let preferences = {};
					for (const bike in input) {
						const parsed_value = parseInt(input[bike]);
						if (!isNaN(parsed_value) && parsed_value >= 0 && parsed_value <= 3) {
							preferences[bike] = parsed_value;
						} else {
							console.log("Not a valid preference for this bike");

							// TODO: this should be a critical error maybe throw something
							res.setHeader("Content-Type", "text/html; charset=utf-8");
							res.writeHead(404);
							res.end(await create_error_page("Selezione di bici non valida"));
							return;
						}
					}

					console.log(`Store preferences for ${association}`);
					await drive.store_bike_preference(association, recovery_date, preferences);

					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.writeHead(200);
					res.end(create_bike_preference_submitted_page(recovery_date));
				} else {
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.writeHead(404);
					res.end(await create_error_page());
				}
				break
			case "/assigned-bikes":
				var recovery_date = url.query.recovery_date;
				// TODO: show error if we don't have a valid recovery_date
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.writeHead(200);
				res.end(await create_assigned_bikes_page(recovery_date, association));
				break
			case "/bike":
				const bike_id = url.query.bike_id;
				const size = url.query.size;
				// TODO: offer the images directly without redirect, because loading the thumbnail may fail
				let image_url = await drive.load_bike_image(bike_id, size);
				res.writeHead(307, {
					'Location': image_url,
				});
				res.end();
				break;
			default:
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.writeHead(404);
				res.end(await create_error_page());
		}
	}
}
/*
	  const proxy = http.get(bike_url)
	  proxy.once('response', proxyResponse => {
		      proxyResponse.pipe(response);
	  });
	  request.pipe(proxy);
	  */



const server = http.createServer(requestListener);
server.listen(port, host, () => {
	console.log(`Server is running on http://${host}:${port}`);
});

function create_error_page(error) {
	var html = [];
	html.push(
		"<!DOCTYPE html>",
		"<body>",
		"<center>",
		"<h2>Pagina non trovato</h2>",
		"<h4>Hai raggiunto una pagina che non esiste</h4>",
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
		'<a href="/add-recovery-date" style="margin-right: 10px;">',
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

	var d = new Date()
	d.setDate(d.getDate() + (((1 + 7 - d.getDay()) % 7) || 7));
	var probably_next_date = `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

	console.log(probably_next_date);
	html.push(
		'<form action="" method="get">',
		'<div>',
		'<label>Data del ritiro: ',
		`<input type="date" name="recovery_date" value="${probably_next_date}" required />`,
		'</label>',
		'</div>',
		'<div>',
		'<label>Link della cartella delle foto: ',
		'<input type="url" name="recovery_images" value="" required />',
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
		'<form action="/select-bike-preference" method="get">',
		'<input type="submit" name="recovery_date" value="2022-12-05" />',
		'</form>',
	);

	html.push(
		"<h3>Ritiri passati</h3>",
	);

	html.push(
		'<form action="/assigned-bikes" method="get">',
		'<input type="submit" name="recovery_date" value="2022-12-05" />',
		'</form>',
	);

	html.push(
		"</center>",
		"</body>",
		"</html>"
	);
	return html.join("");
}


async function create_select_bike_preference_page(recovery_date) {
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
		`<h2>Scelgi le bici che la tua assocazione vorebbe ritirare il ${recovery_date}</h2>`,
		`<form action="/bike-preference-submitted?recovery_date=${recovery_date}" method="post">`,
	);

	let bikes = await drive.find_bikes(recovery_date);

	for (const bike of bikes) {
		html.push(
			"<div>",
			`<h3>Bici: ${bike.id} </h3>`,
			`<img src="/bike?bike_id=${bike.file_id}&size=800" alt="${bike.file_name}">`,
			'<div>',
			`<input type="radio" id="selection_3_${bike.id}" name="${bike.id}" value="3">`,
			`<label for="selection_3_${bike.id}">Mi interessa molto</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_2_${bike.id}" name="${bike.id}" value="2">`,
			`<label for="selection_2_${bike.id}">Mi interessa</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_1_${bike.id}" name="${bike.id}" value="1">`,
			`<label for="selection_1_${bike.id}">Mi interessa poco</label>`,
			'</div>',
			'<div>',
			`<input type="radio" id="selection_0_${bike.id}" name="${bike.id}" value="0" checked="checked">`,
			`<label for="selection_0_${bike.id}">Non mi interessa</label>`,
			'</div>',
			"</div>",
			"<hr>",
		)
	}

	html.push(
		// TODO: show number of selected bikes
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

// TODO: Show message that the deadline wasn't reached yet before deadline
// TODO: Allow to delete selection before deadline
async function create_assigned_bikes_page(recovery_date, association) {
	// TODO: do this only once
	await calculate_assigned_bikes(recovery_date);

	let bikes = await drive.load_assigned_bikes(recovery_date);
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
	let bikes = await drive.find_bikes();
	let assigned_bikes = [];
	for (const association of association_list) {
		preference_list[association.id] = await drive.load_bike_preference(association.id, recovery_date);
		if (points[association.id] === undefined) {
			points[association.id] = 0;
		}
		no_selected_bikes[association.id] = 0;
		for (const bike in preference_list[association.id]) {
			if (preference_list[association.id][bike] !== 0) {
				no_selected_bikes[association.id] += 1; 
			}
		}
	}

	for (const priority of [3, 2, 1]) {
		// We need to shuffle the list of bikes to randomize how the bikes are selected
		for (var bike of shuffle(bikes)) {
			let interested = [];
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
					interested.push(association.id);
				}
			}
			if (interested.length === 0) {
				continue;
			}

			console.log("Number of conflicting: " + interested.length + " bike: " + bike.id + " " + interested);

			let ass_with_max_points = interested[0];
			for (const ass of interested) {
				if (ass === ass_with_max_points) {
				} else if (points[ass] === points[ass_with_max_points]) {
					// Select at random which association should recive the bike
					if (Math.floor(Math.random() * 2) === 0) {
						ass_with_max_points = ass;
					}
				} else if (points[ass] > points[ass_with_max_points]) {
					ass_with_max_points = ass;
				}
			}
			bike["association"] = ass_with_max_points;
			// FIXME: should this be -1/NUMBER_OF_ASSINGED_BIKES or -1/NUMBER_OF_SELECTED_BIKES?
			// Add multiply by priority to remove more points when a bike with higher priority was assigned
			points[ass_with_max_points] -= 1 * priority / no_selected_bikes[ass_with_max_points];

			for (const ass of interested) {
				if (ass_with_max_points == ass) {
					continue;
				}
				points[ass_with_max_points] += 1 * priority / no_selected_bikes[ass_with_max_points];
			}
		}
	}
	console.log("Store assigment bikes");
	console.log(no_selected_bikes);
	console.log(points);
	console.log(bikes);
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



function is_past_recovery(recovery_date) {
	const today = new Date();
	return ((new Date(recovery_date)) < today)
}
/* TODOS:
- [x] Autentication, identification for different assosciations
- [x] Allow to login
- [ ] Find folder for "tornate", maybe allow to add a new recovery via pasting link
- [ ] Show nummber of selected bikes per preference at the end of bike selection
- [ ] List selected bikes on confirmation page and number of selected bikes per preference
- [x] Load photos from google drive
- [x] Display images and allow setting preferences via html page
- [x] Store preferences
- [x] Load preferences
- [?] Calculate assigned bikes and calculate remaining points
- [x] Show assigned bikes via html page
- [x] Cache folder and file ids, they don't change
- [x] show assigned bikes with information when they will show up
- [x] Store and load points from file 
- [x] Store and load assigned bikes
- [x] show request errors
- [ ] show internal errors
- [x] Make sure that the preference selection isn't lost when the token expires and still send and stored

Nice to have
- [ ] Maintain selection between page loads and logins
- [ ] Invalidate tokens after some time
- [ ] Remove token from token_store after some time
*/

